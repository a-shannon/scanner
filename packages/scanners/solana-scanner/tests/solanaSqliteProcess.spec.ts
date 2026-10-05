import { fork, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SOLANA_SQLITE_BUSY_TIMEOUT_MS } from '../lib/store/solanaSqliteDataSource';
import {
  cleanupDatabase,
  initializeDatabase,
  openReader,
  tempDatabase,
} from './process/solanaSqliteProcess.fixtures';

type WorkerMessage = Record<string, unknown> & { type?: string; key?: string };

const workerPath = fileURLToPath(
  new URL('./process/solanaSqliteProcess.worker.ts', import.meta.url),
);
const packageTsconfig = fileURLToPath(
  new URL('../tsconfig.json', import.meta.url),
);

/** Coordinates one SQLite worker process through messages and checkpoints. */
class ProcessHarness {
  private readonly messages: WorkerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
  }> = [];
  readonly child: ChildProcess;
  readonly stderr: string[] = [];

  /** Forks the worker and subscribes to IPC and standard-error events. */
  constructor() {
    this.child = fork(workerPath, [], {
      cwd: process.cwd(),
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, TSX_TSCONFIG_PATH: packageTsconfig },
      serialization: 'advanced',
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => this.stderr.push(chunk));
    this.child.on('message', (value: WorkerMessage) => {
      const waiterIndex = this.waiters.findIndex(({ predicate }) =>
        predicate(value),
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.resolve(value);
      } else this.messages.push(value);
    });
  }

  /** Resolves on the next matching worker message or rejects on timeout. */
  waitFor = (
    predicate: (message: WorkerMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<WorkerMessage> => {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0)
      return Promise.resolve(this.messages.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(
          (waiter) => waiter.resolve === resolve,
        );
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(
            `WORKER_MESSAGE_TIMEOUT; stderr=${this.stderr.join('').slice(-2000)}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  /** Sends one control message to the worker process. */
  send = (message: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      this.child.send(message, (error) => (error ? reject(error) : resolve()));
    });

  /** Waits for worker readiness, then starts the requested operation. */
  start = async (message: Record<string, unknown>): Promise<void> => {
    try {
      await this.waitFor((item) => item.type === 'online');
      await this.send(message);
    } catch (error) {
      await this.kill();
      throw error;
    }
  };

  /** Releases a worker paused at the named checkpoint. */
  release = (key: string): Promise<void> => this.send({ type: 'release', key });

  /** Waits for the result message and for the process to exit. */
  finish = async (): Promise<WorkerMessage> => {
    const result = await this.waitFor((message) => message.type === 'done');
    await this.waitForExit();
    return result;
  };

  /** Resolves with the child's exit code and signal. */
  waitForExit = (): Promise<{ code: number | null; signal: string | null }> =>
    new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        resolve({ code: this.child.exitCode, signal: this.child.signalCode });
      else this.child.once('exit', (code, signal) => resolve({ code, signal }));
    });

  /** Terminates a live child and waits for its exit. */
  kill = async (): Promise<void> => {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill();
    await this.waitForExit();
  };
}

/** Starts a worker operation against the supplied database. */
const spawnRun = async (
  database: string,
  options: Record<string, unknown>,
): Promise<ProcessHarness> => {
  const harness = new ProcessHarness();
  await harness.start({ type: 'run', database, ...options });
  return harness;
};

/** Reads the durable revision, cursor slot, and hold code. */
const stateRows = async (reader: Awaited<ReturnType<typeof openReader>>) =>
  reader.query(
    'SELECT "revision", "cursorSlot", "holdCode" FROM "solana_scan_state" WHERE "id" = 1',
  );

/** Reads all persisted scanner projections through an independent connection. */
const completeSnapshot = async (
  reader: Awaited<ReturnType<typeof openReader>>,
): Promise<Record<string, unknown>> => {
  const state = await reader.query(
    'SELECT "revision", "cursorSlot", "cursorBlockHeight", "cursorBlockhash", "scannedThroughSlot", "holdCode" FROM "solana_scan_state" WHERE "id" = 1',
  );
  const blocks = await reader.query(
    'SELECT "height", "hash", "status", "extra" FROM "block_entity" WHERE "scanner" = ? ORDER BY "height"',
    ['solana-mainnet'],
  );
  const evidence = await reader.query(
    'SELECT "sourceTxId" FROM "solana_observation_evidence"',
  );
  const observations = await reader.query(
    'SELECT "sourceTxId" FROM "observation_entity"',
  );
  const status = await reader.query(
    'SELECT "updateHeight", "updateBlockHash" FROM "extractor_status_entity" WHERE "scannerId" = ? AND "extractorId" = ?',
    ['solana-mainnet', 'solana-v1'],
  );
  return { state, blocks, evidence, observations, status };
};

/** Initializes and cleans up a temporary database around one process test. */
const withDatabase = async <T>(
  callback: (database: string) => Promise<T>,
): Promise<T> => {
  const database = tempDatabase();
  try {
    await initializeDatabase(database);
    return await callback(database);
  } finally {
    await cleanupDatabase(database);
  }
};

/** Waits until a worker reports arrival at the requested write checkpoint. */
const waitForCheckpoint = (
  worker: ProcessHarness,
  key: string,
): Promise<WorkerMessage> =>
  worker.waitFor(
    (message) => message.type === 'checkpoint' && message.key === key,
  );

describe('Solana SQLite process and recovery boundaries', () => {
  /**
   * @target SqliteSolanaScanStore.withExclusiveScan allows one of two OS processes to install the same revision
   * @dependencies two worker processes, shared SQLite database, and process fixtures
   * @scenario pause both installers after reading the same snapshot, then release them together
   * @expected one process commits revision one while the other receives a conflict
   */
  it('allows one of two OS processes to install the same revision', async () =>
    withDatabase(async (database) => {
      const first = await spawnRun(database, {
        operation: 'install',
        pauseAt: ['snapshot-read'],
      });
      const second = await spawnRun(database, {
        operation: 'install',
        pauseAt: ['snapshot-read'],
      });
      try {
        await Promise.all([
          waitForCheckpoint(first, 'snapshot-read'),
          waitForCheckpoint(second, 'snapshot-read'),
        ]);
        await Promise.all([
          first.release('snapshot-read'),
          second.release('snapshot-read'),
        ]);
        const results = await Promise.all([first.finish(), second.finish()]);
        expect(results.filter((result) => result.ok === true)).toHaveLength(1);
        expect(results.filter((result) => result.ok === false)).toHaveLength(1);
        expect(
          results.find((result) => result.ok === false)?.error,
        ).toMatchObject({ kind: 'conflict' });

        const reader = await openReader(database);
        try {
          const snapshot = await completeSnapshot(reader);
          expect(snapshot.state).toMatchObject([
            { revision: 1, cursorSlot: 103, cursorBlockHeight: 51 },
          ]);
          expect(snapshot.evidence).toHaveLength(1);
          expect(snapshot.observations).toHaveLength(1);
        } finally {
          await reader.destroy();
        }
      } finally {
        await Promise.all([first.kill(), second.kill()]);
      }
    }));

  /**
   * @target SqliteSolanaScanStore.withExclusiveScan returns after the configured finite busy_timeout while another OS process owns the write lock
   * @dependencies lock-holding worker, competing installer, and configured SQLite busy timeout
   * @scenario hold a write lock in one process while a second process attempts installation
   * @expected the contender returns SQLITE_BUSY within the bounded timeout and state remains unchanged
   */
  it('returns after the configured finite busy_timeout while another OS process owns the write lock', async () =>
    withDatabase(async (database) => {
      const locker = await spawnRun(database, { operation: 'lock' });
      await locker.waitFor((message) => message.type === 'locked');
      const startedAt = Date.now();
      const contender = await spawnRun(database, { operation: 'install' });
      try {
        const result = await contender.finish();
        const elapsedMs = Date.now() - startedAt;
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'SQLITE_BUSY', kind: 'conflict' },
        });
        expect(elapsedMs).toBeGreaterThanOrEqual(
          SOLANA_SQLITE_BUSY_TIMEOUT_MS - 750,
        );
        expect(elapsedMs).toBeLessThan(SOLANA_SQLITE_BUSY_TIMEOUT_MS + 8_000);
      } finally {
        await locker.release('release-lock');
        await locker.finish();
        await contender.kill();
      }

      const reader = await openReader(database);
      try {
        const snapshot = await completeSnapshot(reader);
        expect(snapshot.state).toMatchObject([
          { revision: 0, cursorSlot: 100, holdCode: null },
        ]);
        expect(snapshot.evidence).toHaveLength(0);
        expect(snapshot.observations).toHaveLength(0);
      } finally {
        await reader.destroy();
      }
    }));

  /**
   * @target SqliteSolanaScanStore recovers through a new OS process after a writer dies %s commit before acknowledgement
   * @dependencies child writer paused immediately before or after the SQLite commit
   * @scenario terminate the paused writer and read the database from a new process
   * @expected recovery exposes either the old complete state or the new committed state
   */
  it.each([
    ['before', 0, 0],
    ['after', 1, 1],
  ] as const)(
    'recovers through a new OS process after a writer dies %s commit before acknowledgement',
    async (commitPause, expectedRevision, expectedEvidence) =>
      withDatabase(async (database) => {
        const writer = await spawnRun(database, {
          operation: 'install',
          commitPause,
        });
        try {
          const checkpoint = await waitForCheckpoint(
            writer,
            `${commitPause}-commit`,
          );
          expect(checkpoint.type).toBe('checkpoint');
          await writer.kill();
        } finally {
          await writer.kill();
        }

        const restarted = await spawnRun(database, { operation: 'read' });
        const result = await restarted.finish();
        expect(result).toMatchObject({
          ok: true,
          result: {
            revision: expectedRevision,
            cursor: { slot: expectedRevision === 0 ? 100 : 103 },
          },
        });

        const reader = await openReader(database);
        try {
          const snapshot = await completeSnapshot(reader);
          expect(snapshot.state).toMatchObject([
            {
              revision: expectedRevision,
              cursorSlot: expectedRevision === 0 ? 100 : 103,
            },
          ]);
          expect(snapshot.evidence).toHaveLength(expectedEvidence);
          expect(snapshot.observations).toHaveLength(expectedEvidence);
          expect(snapshot.blocks).toHaveLength(expectedEvidence + 1);
        } finally {
          await reader.destroy();
        }
      }),
  );

  /**
   * @target SqliteSolanaScanStore.withExclusiveScan serializes competing hold and install processes without a mixed revision
   * @dependencies concurrent installer and holder workers sharing one database
   * @scenario release both workers after they read the same initial snapshot
   * @expected one operation wins and persisted cursor, hold, evidence, and observation agree
   */
  it('serializes competing hold and install processes without a mixed revision', async () =>
    withDatabase(async (database) => {
      const installer = await spawnRun(database, {
        operation: 'install',
        pauseAt: ['snapshot-read'],
      });
      const holder = await spawnRun(database, {
        operation: 'hold',
        pauseAt: ['snapshot-read'],
      });
      try {
        await Promise.all([
          waitForCheckpoint(installer, 'snapshot-read'),
          waitForCheckpoint(holder, 'snapshot-read'),
        ]);
        await Promise.all([
          installer.release('snapshot-read'),
          holder.release('snapshot-read'),
        ]);
        const [installResult, holdResult] = await Promise.all([
          installer.finish(),
          holder.finish(),
        ]);
        const reader = await openReader(database);
        try {
          const snapshot = await completeSnapshot(reader);
          expect(snapshot.state).toMatchObject([
            expect.objectContaining({ revision: 1 }),
          ]);
          if (installResult.ok) {
            expect(holdResult.ok).toBe(false);
            expect(snapshot.state).toMatchObject([
              expect.objectContaining({ cursorSlot: 103, holdCode: null }),
            ]);
            expect(snapshot.evidence).toHaveLength(1);
            expect(snapshot.observations).toHaveLength(1);
          } else {
            expect(holdResult).toMatchObject({ ok: true });
            expect(snapshot.state).toMatchObject([
              expect.objectContaining({
                cursorSlot: 100,
                holdCode: 'PROCESS_HOLD',
              }),
            ]);
            expect(snapshot.evidence).toHaveLength(0);
            expect(snapshot.observations).toHaveLength(0);
            expect(installResult.error).toMatchObject({ kind: 'conflict' });
          }
        } finally {
          await reader.destroy();
        }
      } finally {
        await Promise.all([installer.kill(), holder.kill()]);
      }
    }));

  /**
   * @target SqliteSolanaScanStore.installBatch keeps a separate reader on the old complete snapshot after every write family
   * @dependencies independent SQLite reader and writer paused across each install write family
   * @scenario inspect the reader after every checkpoint, then release the writer to commit
   * @expected the reader sees the old complete snapshot until the new complete revision is committed
   */
  it('keeps a separate reader on the old complete snapshot after every write family', async () =>
    withDatabase(async (database) => {
      const reader = await openReader(database);
      const before = await completeSnapshot(reader);
      const families = [
        'install-revision',
        'block-insert',
        'evidence-insert',
        'observation-insert',
        'block-proceed',
        'extractor-status',
        'cursor-update',
      ];
      const writer = await spawnRun(database, {
        operation: 'install',
        pauseAt: families,
      });
      try {
        for (const family of families) {
          await waitForCheckpoint(writer, family);
          expect(
            await completeSnapshot(reader),
            `reader during ${family}`,
          ).toEqual(before);
          await writer.release(family);
        }
        expect(await writer.finish()).toMatchObject({ ok: true });
        const after = await completeSnapshot(reader);
        expect(after.state).toMatchObject([
          { revision: 1, cursorSlot: 103, cursorBlockHeight: 51 },
        ]);
        expect(after.evidence).toHaveLength(1);
        expect(after.observations).toHaveLength(1);
      } finally {
        await writer.kill();
        await reader.destroy();
      }
    }));

  /**
   * @target SqliteSolanaScanStore.installBatch rolls back atomically when write family %s fails
   * @dependencies worker fault injected separately into each batch write family
   * @scenario fail one write and inspect state, block, evidence, observation, and status tables
   * @expected all batch writes roll back and the anchor revision remains intact
   */
  it.each([
    'install-revision',
    'block-insert',
    'evidence-insert',
    'observation-insert',
    'block-proceed',
    'extractor-status',
    'cursor-update',
  ] as const)(
    'rolls back atomically when write family %s fails',
    async (failAt) =>
      withDatabase(async (database) => {
        const worker = await spawnRun(database, {
          operation: 'install',
          failAt,
        });
        const result = await worker.finish();
        expect(result).toMatchObject({ ok: false });
        const reader = await openReader(database);
        try {
          const snapshot = await completeSnapshot(reader);
          expect(snapshot.state).toMatchObject([
            { revision: 0, cursorSlot: 100, holdCode: null },
          ]);
          expect(snapshot.blocks).toHaveLength(1);
          expect(snapshot.evidence).toHaveLength(0);
          expect(snapshot.observations).toHaveLength(0);
          expect(snapshot.status).toMatchObject([
            { updateHeight: 50, updateBlockHash: '1'.repeat(32) },
          ]);
        } finally {
          await reader.destroy();
        }
      }),
  );

  /**
   * @target SqliteSolanaScanStore.persistHold fails closed when hold persistence fails
   * @dependencies initialized database and worker failing at the hold-state write
   * @scenario request hold persistence and inspect the durable scan state
   * @expected the worker reports failure and the prior revision, cursor, and null hold remain unchanged
   */
  it('fails closed when hold persistence fails', async () => {
    const database = tempDatabase();
    try {
      await initializeDatabase(database);
      const worker = await spawnRun(database, {
        operation: 'hold',
        failAt: 'hold-state',
      });
      expect(await worker.finish()).toMatchObject({ ok: false });
      const reader = await openReader(database);
      try {
        expect(await stateRows(reader)).toMatchObject([
          { revision: 0, cursorSlot: 100, holdCode: null },
        ]);
      } finally {
        await reader.destroy();
      }
    } finally {
      await cleanupDatabase(database);
    }
  });
});
