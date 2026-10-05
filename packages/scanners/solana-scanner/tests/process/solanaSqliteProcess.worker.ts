import { DataSource } from '@rosen-bridge/extended-typeorm';

import {
  configureSolanaSqliteWriter,
  createSolanaSqliteWriterDataSource,
} from '../../lib/store/solanaSqliteDataSource';
import { SqliteSolanaScanStore } from '../../lib/store/sqliteSolanaScanStore';
import {
  createProfile,
  nextBatch,
  nextBlock,
} from './solanaSqliteProcess.fixtures';

type WriteFamily =
  | 'install-revision'
  | 'block-insert'
  | 'evidence-insert'
  | 'observation-insert'
  | 'block-proceed'
  | 'extractor-status'
  | 'cursor-update'
  | 'hold-state';

type RunMessage = {
  type: 'run';
  database: string;
  operation: 'install' | 'hold' | 'read' | 'lock';
  pauseAt?: string[];
  failAt?: WriteFamily;
  commitPause?: 'before' | 'after';
};

const waiting = new Map<string, () => void>();
const released = new Set<string>();

process.on('message', (message: { type?: string; key?: string }) => {
  if (message.type !== 'release' || !message.key) return;
  const resume = waiting.get(message.key);
  if (resume) {
    waiting.delete(message.key);
    resume();
  } else released.add(message.key);
});

/** Sends a structured worker message to the parent process. */
const send = (message: Record<string, unknown>): Promise<void> =>
  new Promise((resolve, reject) => {
    process.send?.(message, (error: Error | null) =>
      error ? reject(error) : resolve(),
    );
    if (!process.send) reject(new Error('IPC_UNAVAILABLE'));
  });

/** Announces and waits at a named checkpoint until the parent releases it. */
const pauseAt = async (key: string): Promise<void> => {
  await send({ type: 'checkpoint', key });
  if (released.delete(key)) return;
  await new Promise<void>((resolve) => waiting.set(key, resolve));
};

/** Maps scanner SQL statements to the write family used by process probes. */
const classifyWrite = (sql: string): WriteFamily | undefined => {
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
  if (
    normalized.includes('update "solana_scan_state"') &&
    normalized.includes('"holdcode" = ?')
  )
    return 'hold-state';
  if (
    normalized.includes('update "solana_scan_state"') &&
    normalized.includes('set "revision" = "revision" + 1')
  )
    return 'install-revision';
  if (normalized.includes('insert into "block_entity"')) return 'block-insert';
  if (normalized.includes('insert into "solana_observation_evidence"'))
    return 'evidence-insert';
  if (normalized.includes('insert into "observation_entity"'))
    return 'observation-insert';
  if (normalized.includes('update "block_entity"')) return 'block-proceed';
  if (normalized.includes('update "extractor_status_entity"'))
    return 'extractor-status';
  if (
    normalized.includes('update "solana_scan_state"') &&
    normalized.includes('set "cursorslot"')
  )
    return 'cursor-update';
  return undefined;
};

/** Wraps a real SQLite writer to pause or fail at configured write boundaries. */
const instrumentWriter = (
  database: string,
  message: RunMessage,
): DataSource => {
  const writer = createSolanaSqliteWriterDataSource(database);
  const createQueryRunner = writer.createQueryRunner.bind(writer);
  const patched = new WeakSet<object>();
  const paused = new Set<string>();
  const commitArmed = new WeakSet<object>();
  writer.createQueryRunner = () => {
    const runner = createQueryRunner();
    if (patched.has(runner)) return runner;
    patched.add(runner);

    const query = runner.query.bind(runner);
    runner.query = async (
      sql: string,
      parameters?: unknown[],
      useStructuredResult?: boolean,
    ) => {
      const family = classifyWrite(sql);
      if (family === 'install-revision' || family === 'hold-state')
        commitArmed.add(runner);
      if (family && family === message.failAt) {
        await send({ type: 'injected-failure', family });
        throw new Error(`TEST_INJECTED_WRITE_FAILURE:${family}`);
      }
      const result =
        useStructuredResult === true
          ? await query(sql, parameters, true)
          : await query(sql, parameters);
      if (family && message.pauseAt?.includes(family) && !paused.has(family)) {
        paused.add(family);
        await pauseAt(family);
      }
      if (
        message.pauseAt?.includes('snapshot-read') &&
        !paused.has('snapshot-read') &&
        /^select \* from "solana_scan_state" where "id" = 1$/i.test(sql.trim())
      ) {
        paused.add('snapshot-read');
        await pauseAt('snapshot-read');
      }
      return result;
    };

    if (message.commitPause) {
      const commit = runner.commitTransaction.bind(runner);
      runner.commitTransaction = async () => {
        if (commitArmed.has(runner) && message.commitPause === 'before')
          await pauseAt('before-commit');
        await commit();
        if (commitArmed.has(runner) && message.commitPause === 'after')
          await pauseAt('after-commit');
      };
    }
    return runner;
  };
  return writer;
};

/** Serializes stable error fields for the parent-process result message. */
const describeError = (error: unknown): Record<string, unknown> => {
  const value = error as {
    name?: string;
    message?: string;
    code?: string;
    kind?: string;
    driverError?: { code?: string };
  };
  return {
    name: value?.name,
    message: value?.message ?? String(error),
    code: value?.code,
    kind: value?.kind,
    driverCode: value?.driverError?.code,
  };
};

/** Executes the requested lock, hold, install, or read operation in this worker. */
const run = async (message: RunMessage): Promise<void> => {
  if (message.operation === 'lock') {
    const writer = createSolanaSqliteWriterDataSource(message.database);
    await writer.initialize();
    await configureSolanaSqliteWriter(writer);
    const runner = writer.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      'UPDATE "solana_scan_state" SET "revision" = "revision" WHERE "id" = 1',
    );
    await send({ type: 'locked' });
    await pauseAt('release-lock');
    await runner.rollbackTransaction();
    await runner.release();
    await writer.destroy();
    await send({ type: 'done', ok: true });
    process.disconnect();
    return;
  }

  const store = new SqliteSolanaScanStore(
    createProfile(),
    message.database,
    (database) => instrumentWriter(database, message),
  );
  try {
    const result = await store.withExclusiveScan(async () => {
      if (message.operation === 'read') return store.readState();
      if (message.operation === 'hold') {
        await store.persistHold(0, 'PROCESS_HOLD');
        return store.readState();
      }
      await store.installBatch(
        0,
        {
          cursor: {
            slot: nextBlock.slot,
            blockHeight: nextBlock.blockHeight,
            blockhash: nextBlock.blockhash,
          },
          scannedThroughSlot: nextBlock.slot,
        },
        nextBatch(),
      );
      return store.readState();
    });
    await send({ type: 'done', ok: true, result });
  } catch (error) {
    await send({ type: 'done', ok: false, error: describeError(error) });
  } finally {
    await store.close();
    process.disconnect();
  }
};

process.on('message', (message: RunMessage | { type: string }) => {
  if (message.type !== 'run') return;
  void run(message as RunMessage).catch(async (error) => {
    await send({ type: 'fatal', error: describeError(error) });
    process.exitCode = 1;
    process.disconnect();
  });
});

void send({ type: 'online' });
