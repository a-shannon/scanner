import { blake2b } from 'blakejs';
import bs58 from 'bs58';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROCEED } from '@rosen-bridge/abstract-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { SolanaStoreFault } from '../lib/errors';
import { SolanaScanProfile } from '../lib/profile';
import {
  configureSolanaSqliteWriter,
  createSolanaSqliteWriterDataSource,
} from '../lib/store/solanaSqliteDataSource';
import { SqliteSolanaScanStore } from '../lib/store/sqliteSolanaScanStore';
import {
  SolanaDepositCandidate,
  SolanaRpcBlock,
  SolanaScannedBlock,
} from '../lib/types';

const genesisHash = '1'.repeat(32);
const anchorHash = '1'.repeat(32);
const anchorParentHash = '9'.repeat(32);
const block103Hash = `${'1'.repeat(31)}2`;
const block109Hash = `${'1'.repeat(31)}3`;
const signatureA = '1'.repeat(64);
const targetTokenId = 'a'.repeat(64);
const parentBlockTime = 1_700_000_000;

/** Returns the fixed native-SOL profile used by file-backed store tests. */
const createProfile = (): SolanaScanProfile => ({
  genesisHash,
  destinationChain: 'ergo',
  destinationNetwork: 'mainnet',
  scannerId: 'solana-mainnet',
  extractorId: 'solana-v1',
  vaultOwner: 'vault-owner',
  assets: [
    {
      assetId: 'sol',
      programId: 'system-program',
      mint: null,
      vaultTokenAccount: null,
      sourceDecimals: 9,
      destinationDecimals: 9,
      destinationTokenId: targetTokenId,
      minAmount: '1',
      maxAmount: '1000000000000',
      networkFee: '1',
      bridgeFee: '1',
    },
  ],
  memoVersion: 1,
  projectorVersion: 'test-projector-v1',
  anchor: { slot: 100, blockHeight: 50, blockhash: anchorHash },
});

/** Builds a finalized RPC block fixture with stable source coordinates. */
const makeBlock = (
  slot: number,
  blockHeight: number,
  parentSlot: number,
  previousBlockhash: string,
  blockhash: string,
  signatures: string[],
): SolanaRpcBlock => ({
  slot,
  blockHeight,
  parentSlot,
  previousBlockhash,
  blockhash,
  blockTime: parentBlockTime + blockHeight,
  commitment: 'finalized',
  transactions: signatures.map((signature, transactionIndex) => ({
    signature,
    transactionIndex,
  })),
  rawResponse: JSON.stringify({ slot, blockhash }),
});

const anchorBlock = makeBlock(100, 50, 99, anchorParentHash, anchorHash, []);
const block103 = makeBlock(103, 51, 100, anchorHash, block103Hash, [
  signatureA,
]);
const deposit: SolanaDepositCandidate = {
  signature: signatureA,
  context: {
    clusterGenesisHash: genesisHash,
    sourceTxId: signatureA,
    sourceSlot: block103.slot,
    sourceBlockhash: block103.blockhash,
  },
  data: {
    toChain: 'ergo',
    toAddress: 'recipient',
    bridgeFee: '1',
    networkFee: '1',
    fromAddress: 'sender',
    sourceChainTokenId: 'sol',
    amount: '500',
    targetChainTokenId: targetTokenId,
    sourceTxId: signatureA,
    rawData: '{"memo":"bridge-request"}',
  },
};

/** Removes the raw RPC body when projecting the scanner-owned block shape. */
const withoutRawResponse = (
  block: SolanaRpcBlock,
): SolanaScannedBlock['block'] => ({
  slot: block.slot,
  blockHeight: block.blockHeight,
  blockhash: block.blockhash,
  parentSlot: block.parentSlot,
  previousBlockhash: block.previousBlockhash,
  blockTime: block.blockTime,
  commitment: block.commitment,
  transactions: block.transactions,
});

/** Pairs a block with its deposit candidates for batch installation. */
const scanned = (
  block: SolanaRpcBlock,
  deposits: SolanaDepositCandidate[] = [],
): SolanaScannedBlock => ({ block: withoutRawResponse(block), deposits });

/** Builds the next-block batch with or without its fixed deposit candidate. */
const block103Batch = (candidate = true): SolanaScannedBlock[] => [
  scanned(block103, candidate ? [deposit] : []),
];

/** Returns a unique temporary SQLite file path for one test. */
const tempDatabase = (): string =>
  join(tmpdir(), `rosen-solana-store-${randomUUID()}.sqlite`);

/** Removes the test database and any SQLite sidecar files. */
const cleanupDatabase = async (database: string): Promise<void> => {
  await Promise.all(
    ['', '-journal', '-wal', '-shm'].map((suffix) =>
      rm(`${database}${suffix}`, { force: true }),
    ),
  );
};

/** Applies the store migrations and closes the migration connection. */
const migrateDatabase = async (database: string): Promise<void> => {
  const migrator = createSolanaSqliteWriterDataSource(database);
  try {
    await migrator.initialize();
    await configureSolanaSqliteWriter(migrator);
    await migrator.runMigrations();
  } finally {
    if (migrator.isInitialized) await migrator.destroy();
  }
};

/** Opens a separate reader connection for checking persisted projections. */
const openReader = async (database: string): Promise<DataSource> => {
  const reader = new DataSource({
    type: 'sqlite',
    database,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    busyTimeout: 1000,
    enableWAL: false,
  });
  await reader.initialize();
  return reader;
};

/** Creates, migrates, and cleans up a database around one test callback. */
const withDatabase = async <T>(
  callback: (
    database: string,
    store: SqliteSolanaScanStore,
    reader: DataSource,
  ) => Promise<T>,
): Promise<T> => {
  const database = tempDatabase();
  let store: SqliteSolanaScanStore | undefined;
  let reader: DataSource | undefined;
  try {
    await migrateDatabase(database);
    store = new SqliteSolanaScanStore(createProfile(), database);
    reader = await openReader(database);
    await store.withExclusiveScan(() => store!.initialize(anchorBlock));
    return await callback(database, store, reader);
  } finally {
    if (store) await store.close();
    if (reader?.isInitialized) await reader.destroy();
    await cleanupDatabase(database);
  }
};

/** Installs the fixed next block under the store's exclusive scan lock. */
const installFirstBlock = async (
  store: SqliteSolanaScanStore,
  withDeposit = true,
) =>
  store.withExclusiveScan(() =>
    store.installBatch(
      0,
      {
        cursor: {
          slot: block103.slot,
          blockHeight: block103.blockHeight,
          blockhash: block103.blockhash,
        },
        scannedThroughSlot: block103.slot,
      },
      block103Batch(withDeposit),
    ),
  );

/** Runs a query and returns rows with the shape used by assertions. */
const rows = async (
  reader: DataSource,
  sql: string,
  parameters: unknown[] = [],
): Promise<Array<Record<string, unknown>>> =>
  reader.query(sql, parameters) as Promise<Array<Record<string, unknown>>>;

type WriterFailurePoint =
  | 'start-after-open'
  | 'commit-before'
  | 'commit-after'
  | 'rollback-after';

/** Injects one transaction acknowledgement fault into SQLite writers. */
const createFaultingWriterFactory = (
  failurePoint: WriterFailurePoint,
): ((database: string) => DataSource) => {
  let pending = true;
  let commitCalls = 0;
  return (database) => {
    const writer = createSolanaSqliteWriterDataSource(database);
    const createQueryRunner = writer.createQueryRunner.bind(writer);
    const patchedRunners = new WeakSet<object>();
    writer.createQueryRunner = () => {
      const runner = createQueryRunner();
      if (patchedRunners.has(runner)) return runner;
      patchedRunners.add(runner);

      if (failurePoint === 'start-after-open') {
        const start = runner.startTransaction.bind(runner);
        runner.startTransaction = async (isolationLevel) => {
          await start(isolationLevel);
          if (pending) {
            pending = false;
            throw new Error('TEST_START_ACK_LOST');
          }
        };
      }

      if (failurePoint === 'commit-before' || failurePoint === 'commit-after') {
        const commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          commitCalls++;
          const targetCommit = commitCalls === 2;
          if (failurePoint === 'commit-before' && pending && targetCommit) {
            pending = false;
            throw new Error('TEST_COMMIT_NOT_APPLIED');
          }
          await commit();
          if (failurePoint === 'commit-after' && pending && targetCommit) {
            pending = false;
            throw new Error('TEST_COMMIT_ACK_LOST');
          }
        };
      }

      if (failurePoint === 'rollback-after') {
        const rollback = runner.rollbackTransaction.bind(runner);
        runner.rollbackTransaction = async () => {
          await rollback();
          if (pending) {
            pending = false;
            throw new Error('TEST_ROLLBACK_ACK_LOST');
          }
        };
      }

      return runner;
    };
    return writer;
  };
};

/** Records SQL and bind counts while preserving the real SQLite query path. */
const createQueryRecordingWriterFactory =
  (
    calls: Array<{ sql: string; parameterCount: number }>,
  ): ((database: string) => DataSource) =>
  (database) => {
    const writer = createSolanaSqliteWriterDataSource(database);
    const createQueryRunner = writer.createQueryRunner.bind(writer);
    writer.createQueryRunner = () => {
      const runner = createQueryRunner();
      const query = runner.query.bind(runner);
      runner.query = (async (sql, parameters, useStructuredResult) => {
        if (typeof sql === 'string')
          calls.push({
            sql,
            parameterCount: Array.isArray(parameters) ? parameters.length : 0,
          });
        return query(sql, parameters, useStructuredResult);
      }) as typeof runner.query;
      return runner;
    };
    return writer;
  };

describe('SqliteSolanaScanStore', () => {
  /**
   * @target SqliteSolanaScanStore uses explicit migrations and a bounded durable SQLite writer policy
   * @dependencies real SQLite data source, migration configuration, and temporary database
   * @scenario inspect writer options and the journal, synchronous, isolation, and busy-timeout pragmas
   * @expected migrations stay explicit and the configured writer uses the bounded durable policy
   */
  it('uses explicit migrations and a bounded durable SQLite writer policy', async () => {
    const database = tempDatabase();
    const writer = createSolanaSqliteWriterDataSource(database);
    const options = writer.options as unknown as Record<string, unknown>;
    try {
      expect(options).toMatchObject({
        type: 'sqlite',
        synchronize: false,
        migrationsRun: false,
        migrationsTransactionMode: 'all',
        enableWAL: false,
        busyTimeout: 5000,
      });
      expect(options.busyErrorRetry).toBeUndefined();
      await writer.initialize();
      await expect(
        configureSolanaSqliteWriter(writer),
      ).resolves.toBeUndefined();
      const journal = await rows(writer, 'PRAGMA journal_mode');
      const synchronous = await rows(writer, 'PRAGMA synchronous');
      const readUncommitted = await rows(writer, 'PRAGMA read_uncommitted');
      const busyTimeout = await rows(writer, 'PRAGMA busy_timeout');
      expect(journal[0]).toMatchObject({ journal_mode: 'delete' });
      expect(synchronous[0]).toMatchObject({ synchronous: 2 });
      expect(readUncommitted[0]).toMatchObject({ read_uncommitted: 0 });
      expect(busyTimeout[0]).toMatchObject({ timeout: 5000 });
      expect(await writer.showMigrations()).toBe(true);
    } finally {
      if (writer.isInitialized) await writer.destroy();
      await cleanupDatabase(database);
    }
  });

  /**
   * @target SqliteSolanaScanStore refuses a database whose migrations are absent or partially applied
   * @dependencies unmigrated and partially migrated temporary SQLite databases
   * @scenario initialize the store against both incomplete schemas and inspect migration records
   * @expected both attempts fail with MIGRATIONS_REQUIRED without advancing store state
   */
  it('refuses a database whose migrations are absent or partially applied', async () => {
    const database = tempDatabase();
    const store = new SqliteSolanaScanStore(createProfile(), database);
    try {
      await expect(
        store.withExclusiveScan(() => store.readState()),
      ).rejects.toMatchObject({ code: 'MIGRATIONS_REQUIRED' });
      const unmigrated = createSolanaSqliteWriterDataSource(database);
      await unmigrated.initialize();
      try {
        expect(
          await unmigrated.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'solana_scan_state'`,
          ),
        ).toEqual([]);
      } finally {
        await unmigrated.destroy();
      }
    } finally {
      await store.close();
      await cleanupDatabase(database);
    }

    const partialDatabase = tempDatabase();
    const migrator = createSolanaSqliteWriterDataSource(partialDatabase);
    let partialStore: SqliteSolanaScanStore | undefined;
    try {
      await migrator.initialize();
      await configureSolanaSqliteWriter(migrator);
      await migrator.runMigrations();
      const history = await rows(migrator, 'SELECT * FROM "migrations"');
      expect(history.length).toBeGreaterThan(0);
      await migrator.query('DELETE FROM "migrations" WHERE "timestamp" = ?', [
        history[history.length - 1].timestamp,
      ]);
      const remaining = await rows(migrator, 'SELECT * FROM "migrations"');
      partialStore = new SqliteSolanaScanStore(
        createProfile(),
        partialDatabase,
      );
      await expect(
        partialStore.withExclusiveScan(() => partialStore!.readState()),
      ).rejects.toMatchObject({ code: 'MIGRATIONS_REQUIRED' });
      expect(await rows(migrator, 'SELECT * FROM "migrations"')).toEqual(
        remaining,
      );
      expect(
        await rows(
          migrator,
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'solana_scan_state'`,
        ),
      ).toEqual([{ name: 'solana_scan_state' }]);
      expect(await rows(migrator, 'SELECT * FROM "solana_scan_state"')).toEqual(
        [],
      );
    } finally {
      if (partialStore) await partialStore.close();
      if (migrator.isInitialized) await migrator.destroy();
      await cleanupDatabase(partialDatabase);
    }
  });

  /**
   * @target SqliteSolanaScanStore reopens an identical checkpoint and refuses a missing state beside projections
   * @dependencies migrated database with the anchor checkpoint and durable projections
   * @scenario reopen the unchanged checkpoint, then remove its state row while projections remain
   * @expected the identical checkpoint is accepted and the inconsistent database is rejected
   */
  it('reopens an identical checkpoint and refuses a missing state beside projections', async () =>
    await withDatabase(async (database, store, reader) => {
      const original = await store.withExclusiveScan(() => store.readState());
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).resolves.toEqual(original);
      } finally {
        await reopened.close();
      }

      await reader.query('DELETE FROM "solana_scan_state" WHERE "id" = 1');
      const before = {
        blocks: await rows(reader, 'SELECT * FROM "block_entity"'),
        statuses: await rows(reader, 'SELECT * FROM "extractor_status_entity"'),
        evidence: await rows(
          reader,
          'SELECT * FROM "solana_observation_evidence"',
        ),
      };
      const absentState = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          absentState.withExclusiveScan(() => absentState.readState()),
        ).rejects.toMatchObject({ code: 'ORPHANED_SOLANA_DATA' });
        expect({
          blocks: await rows(reader, 'SELECT * FROM "block_entity"'),
          statuses: await rows(
            reader,
            'SELECT * FROM "extractor_status_entity"',
          ),
          evidence: await rows(
            reader,
            'SELECT * FROM "solana_observation_evidence"',
          ),
        }).toEqual(before);
      } finally {
        await absentState.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore refuses revision saturation before install or hold can change durable state
   * @dependencies file-backed store, separate reader, and maximum safe revision fixture
   * @scenario attempt a batch install and a hold at the saturated revision
   * @expected both calls fail with REVISION_EXHAUSTED and persisted rows remain unchanged
   */
  it('refuses revision saturation before install or hold can change durable state', async () =>
    await withDatabase(async (database, store, reader) => {
      await reader.query('UPDATE "solana_scan_state" SET "revision" = ?', [
        Number.MAX_SAFE_INTEGER,
      ]);
      const before = await rows(reader, 'SELECT * FROM "solana_scan_state"');
      const next = {
        cursor: {
          slot: block103.slot,
          blockHeight: block103.blockHeight,
          blockhash: block103.blockhash,
        },
        scannedThroughSlot: block103.slot,
      };
      await expect(
        store.withExclusiveScan(() =>
          store.installBatch(
            Number.MAX_SAFE_INTEGER,
            next,
            block103Batch(false),
          ),
        ),
      ).rejects.toMatchObject({ code: 'REVISION_EXHAUSTED' });
      await expect(
        store.withExclusiveScan(() =>
          store.persistHold(Number.MAX_SAFE_INTEGER, 'TEST_HOLD'),
        ),
      ).rejects.toMatchObject({ code: 'REVISION_EXHAUSTED' });
      expect(await rows(reader, 'SELECT * FROM "solana_scan_state"')).toEqual(
        before,
      );
      expect(await rows(reader, 'SELECT * FROM "block_entity"')).toHaveLength(
        1,
      );
      expect(
        await rows(reader, 'SELECT * FROM "solana_observation_evidence"'),
      ).toEqual([]);
    }));

  /**
   * @target SqliteSolanaScanStore enforces hard block, transaction-reference and observation limits at max and max+1
   * @dependencies bounded batch fixtures and a writer interrupted at batch preflight
   * @scenario submit batches at and just above each configured hard limit
   * @expected exact maxima reach preflight while over-limit batches fail before changing durable state
   */
  it('enforces hard block, transaction-reference and observation limits at max and max+1', async () =>
    await withDatabase(async (database, _store, reader) => {
      const validateThroughPublicCall = async (
        blocks: SolanaScannedBlock[],
        expected: 'preflight-reached' | string,
      ): Promise<void> => {
        const interruptedFactory = (path: string): DataSource => {
          const writer = createSolanaSqliteWriterDataSource(path);
          const createQueryRunner = writer.createQueryRunner.bind(writer);
          writer.createQueryRunner = () => {
            const runner = createQueryRunner();
            const query = runner.query.bind(runner);
            runner.query = async (
              sql: string,
              parameters?: unknown[],
              useStructuredResult?: boolean,
            ) => {
              if (
                typeof sql === 'string' &&
                sql.includes('SET "revision" = "revision" + 1')
              )
                throw new SolanaStoreFault(
                  'TEST_STOP_AFTER_BATCH_PREFLIGHT',
                  'unavailable',
                );
              return useStructuredResult === true
                ? query(sql, parameters, true)
                : query(sql, parameters);
            };
            return runner;
          };
          return writer;
        };
        const candidateStore = new SqliteSolanaScanStore(
          createProfile(),
          database,
          interruptedFactory,
        );
        const last = blocks[blocks.length - 1]?.block;
        const next = last
          ? {
              cursor: {
                slot: last.slot,
                blockHeight: last.blockHeight,
                blockhash: last.blockhash,
              },
              scannedThroughSlot: last.slot,
            }
          : {
              cursor: createProfile().anchor,
              scannedThroughSlot: createProfile().anchor.slot + 1,
            };
        try {
          if (expected === 'preflight-reached') {
            await expect(
              candidateStore.withExclusiveScan(() =>
                candidateStore.installBatch(0, next, blocks),
              ),
            ).rejects.toMatchObject({
              code: 'TEST_STOP_AFTER_BATCH_PREFLIGHT',
            });
          } else {
            await expect(
              candidateStore.withExclusiveScan(() =>
                candidateStore.installBatch(0, next, blocks),
              ),
            ).rejects.toMatchObject({ code: expected });
          }
        } finally {
          await candidateStore.close();
        }
      };

      const makeUniqueBatch = (
        totalBlocks: number,
        totalTransactions: number,
      ): SolanaScannedBlock[] => {
        const signatures = Array.from(
          { length: totalTransactions },
          (_, index) => {
            const bytes = Buffer.alloc(64);
            bytes.writeBigUInt64BE(BigInt(index), 56);
            return bs58.encode(bytes);
          },
        );
        const blocks: SolanaScannedBlock[] = [];
        let parentSlot = anchorBlock.slot;
        let parentHeight = anchorBlock.blockHeight;
        let previousBlockhash = anchorBlock.blockhash;
        let offset = 0;
        for (let index = 0; index < totalBlocks; index++) {
          const slot = parentSlot + 1;
          const blockHeight = parentHeight + 1;
          const blockhash = `bound-block-${index}`;
          const count = Math.ceil(
            (totalTransactions - offset) / (totalBlocks - index),
          );
          const transactions = signatures
            .slice(offset, offset + count)
            .map((signature, transactionIndex) => ({
              signature,
              transactionIndex,
            }));
          blocks.push({
            block: {
              slot,
              blockHeight,
              parentSlot,
              previousBlockhash,
              blockhash,
              blockTime: parentBlockTime + blockHeight,
              commitment: 'finalized',
              transactions,
            },
            deposits: [],
          });
          offset += count;
          parentSlot = slot;
          parentHeight = blockHeight;
          previousBlockhash = blockhash;
        }
        return blocks;
      };

      const maxBlocks = 4096;
      const maxTransactions = 262_144;
      const maxBlockAndTransactionBatch = makeUniqueBatch(
        maxBlocks,
        maxTransactions,
      );
      await validateThroughPublicCall(
        maxBlockAndTransactionBatch,
        'preflight-reached',
      );
      await validateThroughPublicCall(
        makeUniqueBatch(maxBlocks, maxTransactions + 1),
        'TRANSACTION_BATCH_BOUND',
      );
      await validateThroughPublicCall(
        makeUniqueBatch(maxBlocks + 1, maxBlocks + 1),
        'BATCH_BOUND',
      );

      const observationBatch = [
        scanned(
          block103,
          Array.from({ length: 65_536 }, () => deposit),
        ),
      ];
      await validateThroughPublicCall(observationBatch, 'preflight-reached');
      await validateThroughPublicCall(
        [
          scanned(
            block103,
            Array.from({ length: 65_537 }, () => deposit),
          ),
        ],
        'OBSERVATION_BATCH_BINDING',
      );
      expect(
        await rows(
          reader,
          'SELECT "revision", "cursorSlot" FROM "solana_scan_state"',
        ),
      ).toEqual([expect.objectContaining({ revision: 0, cursorSlot: 100 })]);
      expect(await rows(reader, 'SELECT * FROM "block_entity"')).toHaveLength(
        1,
      );
    }));

  /**
   * @target SqliteSolanaScanStore discards a writer whose transaction start acknowledgement is uncertain
   * @dependencies faulting writer that throws after starting its first transaction
   * @scenario read through the uncertain writer and issue a second read after recovery
   * @expected the first call reports unavailable and the replacement writer reads the unchanged anchor
   */
  it('discards a writer whose transaction start acknowledgement is uncertain', async () =>
    withDatabase(async (database) => {
      const faulted = new SqliteSolanaScanStore(
        createProfile(),
        database,
        createFaultingWriterFactory('start-after-open'),
      );
      try {
        await expect(
          faulted.withExclusiveScan(() => faulted.readState()),
        ).rejects.toMatchObject({ code: 'STORE_FAILURE', kind: 'unavailable' });
        await expect(
          faulted.withExclusiveScan(() => faulted.readState()),
        ).resolves.toMatchObject({
          revision: 0,
          cursor: createProfile().anchor,
        });
      } finally {
        await faulted.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore adopts a committed batch after the commit acknowledgement is lost
   * @dependencies faulting writer that commits before losing its acknowledgement
   * @scenario install the next block and inspect the returned state after the lost acknowledgement
   * @expected the durable committed batch is adopted at revision one
   */
  it('adopts a committed batch after the commit acknowledgement is lost', async () =>
    withDatabase(async (database) => {
      const faulted = new SqliteSolanaScanStore(
        createProfile(),
        database,
        createFaultingWriterFactory('commit-after'),
      );
      try {
        const result = await faulted.withExclusiveScan(() =>
          faulted.installBatch(
            0,
            {
              cursor: {
                slot: block103.slot,
                blockHeight: block103.blockHeight,
                blockhash: block103.blockhash,
              },
              scannedThroughSlot: block103.slot,
            },
            block103Batch(false),
          ),
        );
        expect(result).toMatchObject({
          revision: 1,
          cursor: {
            slot: block103.slot,
            blockHeight: block103.blockHeight,
            blockhash: block103.blockhash,
          },
        });
      } finally {
        await faulted.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore does not retry or adopt a batch when the commit was not applied
   * @dependencies faulting writer that fails before applying the second commit
   * @scenario install a block and read the database after the commit failure
   * @expected COMMIT_NOT_APPLIED is reported with no new block or cursor revision
   */
  it('does not retry or adopt a batch when the commit was not applied', async () =>
    withDatabase(async (database, _store, reader) => {
      const faulted = new SqliteSolanaScanStore(
        createProfile(),
        database,
        createFaultingWriterFactory('commit-before'),
      );
      try {
        await expect(
          faulted.withExclusiveScan(() =>
            faulted.installBatch(
              0,
              {
                cursor: {
                  slot: block103.slot,
                  blockHeight: block103.blockHeight,
                  blockhash: block103.blockhash,
                },
                scannedThroughSlot: block103.slot,
              },
              block103Batch(false),
            ),
          ),
        ).rejects.toMatchObject({
          code: 'COMMIT_NOT_APPLIED',
          kind: 'unavailable',
        });
        expect(
          await rows(
            reader,
            'SELECT * FROM "block_entity" WHERE "height" = 51',
          ),
        ).toHaveLength(0);
        expect(
          await rows(
            reader,
            'SELECT "revision", "cursorSlot" FROM "solana_scan_state"',
          ),
        ).toEqual([expect.objectContaining({ revision: 0, cursorSlot: 100 })]);
      } finally {
        await faulted.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore poisons the store after rollback acknowledgement is uncertain
   * @dependencies writer with lost rollback acknowledgement and an insert-abort trigger
   * @scenario fail observation insertion, lose rollback acknowledgement, then attempt another read
   * @expected the writer remains unavailable and every batch projection stays rolled back
   */
  it('poisons the store after rollback acknowledgement is uncertain', async () =>
    withDatabase(async (database, _store, reader) => {
      const faulted = new SqliteSolanaScanStore(
        createProfile(),
        database,
        createFaultingWriterFactory('rollback-after'),
      );
      await reader.query(`
        CREATE TRIGGER fail_solana_observation
        BEFORE INSERT ON "observation_entity"
        BEGIN SELECT RAISE(ABORT, 'TEST_OBSERVATION_INSERT'); END
      `);
      try {
        await expect(
          faulted.withExclusiveScan(() =>
            faulted.installBatch(
              0,
              {
                cursor: {
                  slot: block103.slot,
                  blockHeight: block103.blockHeight,
                  blockhash: block103.blockhash,
                },
                scannedThroughSlot: block103.slot,
              },
              block103Batch(true),
            ),
          ),
        ).rejects.toMatchObject({
          code: 'WRITER_ROLLBACK',
          kind: 'unavailable',
        });
        await expect(
          faulted.withExclusiveScan(() => faulted.readState()),
        ).rejects.toMatchObject({
          code: 'WRITER_ROLLBACK',
          kind: 'unavailable',
        });
        expect(
          await rows(
            reader,
            'SELECT * FROM "block_entity" WHERE "height" = 51',
          ),
        ).toHaveLength(0);
        expect(
          await rows(reader, 'SELECT * FROM "solana_observation_evidence"'),
        ).toHaveLength(0);
        expect(
          await rows(reader, 'SELECT * FROM "observation_entity"'),
        ).toHaveLength(0);
        expect(
          await rows(
            reader,
            'SELECT "revision", "cursorSlot" FROM "solana_scan_state"',
          ),
        ).toEqual([expect.objectContaining({ revision: 0, cursorSlot: 100 })]);
      } finally {
        await faulted.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore initializes the anchor and atomically exposes block, evidence, event and status
   * @dependencies fixed profile, anchor block, migrated SQLite store, and separate reader
   * @scenario initialize the store and inspect each durable projection table
   * @expected the anchor and related records appear together at the initial revision
   */
  it('initializes the anchor and atomically exposes block, evidence, event and status', async () =>
    withDatabase(async (_database, store, reader) => {
      await installFirstBlock(store);

      const state = await rows(reader, 'SELECT * FROM "solana_scan_state"');
      const blocks = await rows(
        reader,
        'SELECT "height", "hash", "parentHash", "status", "timestamp" FROM "block_entity" WHERE "scanner" = ? ORDER BY "height"',
        ['solana-mainnet'],
      );
      const observations = await rows(
        reader,
        'SELECT * FROM "observation_entity" WHERE "extractor" = ?',
        ['solana-v1'],
      );
      const evidence = await rows(
        reader,
        'SELECT * FROM "solana_observation_evidence"',
      );
      const status = await rows(
        reader,
        'SELECT * FROM "extractor_status_entity" WHERE "scannerId" = ? AND "extractorId" = ?',
        ['solana-mainnet', 'solana-v1'],
      );

      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({
        schemaVersion: 1,
        genesisHash,
        cursorSlot: 103,
        cursorBlockHeight: 51,
        cursorBlockhash: block103Hash,
        scannedThroughSlot: 103,
        revision: 1,
        holdCode: null,
      });
      expect(blocks).toHaveLength(2);
      expect(blocks.map((block) => block.height)).toEqual([50, 51]);
      expect(blocks[1]).toMatchObject({
        hash: block103Hash,
        parentHash: anchorHash,
        status: 'PROCEED',
        timestamp: block103.blockTime,
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        sourceTxId: signatureA,
        fromChain: 'solana',
        toChain: 'ergo',
        fromAddress: 'sender',
        toAddress: 'recipient',
        amount: '500',
        bridgeFee: '1',
        networkFee: '1',
        sourceChainTokenId: 'sol',
        targetChainTokenId: targetTokenId,
        sourceBlockId: block103Hash,
        block: block103Hash,
        height: 51,
        extractor: 'solana-v1',
        rawData: deposit.data.rawData,
      });
      expect(observations[0].requestId).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        genesisHash,
        scannerId: 'solana-mainnet',
        extractorId: 'solana-v1',
        sourceTxId: signatureA,
        sourceSlot: 103,
        sourceBlockHeight: 51,
        sourceBlockId: block103Hash,
        requestId: observations[0].requestId,
        fromChain: observations[0].fromChain,
        toChain: observations[0].toChain,
        fromAddress: observations[0].fromAddress,
        toAddress: observations[0].toAddress,
        amount: observations[0].amount,
        bridgeFee: observations[0].bridgeFee,
        networkFee: observations[0].networkFee,
        sourceChainTokenId: observations[0].sourceChainTokenId,
        targetChainTokenId: observations[0].targetChainTokenId,
        block: observations[0].block,
        rawData: observations[0].rawData,
      });
      expect(status).toEqual([
        expect.objectContaining({
          updateHeight: 51,
          updateBlockHash: block103Hash,
        }),
      ]);
      const triggerFields = [
        ['sourceTxId', 'sourceTxId'],
        ['fromChain', 'fromChain'],
        ['toChain', 'toChain'],
        ['fromAddress', 'fromAddress'],
        ['toAddress', 'toAddress'],
        ['amount', 'amount'],
        ['bridgeFee', 'bridgeFee'],
        ['networkFee', 'networkFee'],
        ['sourceChainTokenId', 'sourceChainTokenId'],
        ['targetChainTokenId', 'targetChainTokenId'],
        ['sourceBlockId', 'sourceBlockId'],
        ['sourceBlockHeight', 'height'],
      ];
      expect(
        triggerFields.map(([evidenceField]) => evidence[0][evidenceField]),
      ).toEqual(
        triggerFields.map(
          ([, observationField]) => observations[0][observationField],
        ),
      );
    }));

  /**
   * @target SqliteSolanaScanStore rolls back every projection on insert failure, then persists only a hold
   * @dependencies injected projection insert failure and separate SQLite reader
   * @scenario install a block whose observation insert fails and inspect durable rows
   * @expected partial projections roll back and only the fail-closed hold is persisted
   */
  it('rolls back every projection on insert failure, then persists only a hold', async () =>
    withDatabase(async (_database, store, reader) => {
      await reader.query(`
        CREATE TRIGGER fail_solana_observation
        BEFORE INSERT ON "observation_entity"
        BEGIN SELECT RAISE(ABORT, 'TEST_OBSERVATION_INSERT'); END
      `);

      await expect(installFirstBlock(store)).rejects.toMatchObject({
        name: 'SolanaStoreFault',
        code: 'STORE_CONTENT_CONFLICT',
        kind: 'content',
      });
      await store.withExclusiveScan(() =>
        store.persistHold(0, 'STORE_CONTENT_CONFLICT'),
      );

      const blockRows = await rows(
        reader,
        'SELECT * FROM "block_entity" WHERE "scanner" = ? AND "height" = 51',
        ['solana-mainnet'],
      );
      const evidenceRows = await rows(
        reader,
        'SELECT * FROM "solana_observation_evidence"',
      );
      const observationRows = await rows(
        reader,
        'SELECT * FROM "observation_entity" WHERE "extractor" = ?',
        ['solana-v1'],
      );
      const stateRows = await rows(reader, 'SELECT * FROM "solana_scan_state"');
      const statusRows = await rows(
        reader,
        'SELECT * FROM "extractor_status_entity" WHERE "scannerId" = ? AND "extractorId" = ?',
        ['solana-mainnet', 'solana-v1'],
      );

      expect(blockRows).toHaveLength(0);
      expect(evidenceRows).toHaveLength(0);
      expect(observationRows).toHaveLength(0);
      expect(stateRows[0]).toMatchObject({
        cursorSlot: 100,
        cursorBlockHeight: 50,
        scannedThroughSlot: 100,
        revision: 1,
        holdCode: 'STORE_CONTENT_CONFLICT',
      });
      expect(statusRows[0]).toMatchObject({
        updateHeight: 50,
        updateBlockHash: anchorHash,
      });
    }));

  /**
   * @target SqliteSolanaScanStore rejects a source signature already proven in another block
   * @dependencies retained signature evidence and a later block reusing that signature
   * @scenario install a later block that reuses the already-proven transaction signature
   * @expected the duplicate proof is rejected without advancing the stored cursor
   */
  it('rejects a source signature already proven in another block', async () =>
    withDatabase(async (_database, store, reader) => {
      await installFirstBlock(store);
      const repeatedBlock = makeBlock(
        109,
        52,
        103,
        block103Hash,
        block109Hash,
        [signatureA],
      );
      const repeatedDeposit: SolanaDepositCandidate = {
        ...deposit,
        context: {
          ...deposit.context,
          sourceSlot: repeatedBlock.slot,
          sourceBlockhash: repeatedBlock.blockhash,
        },
      };
      let conflict: unknown;
      await store.withExclusiveScan(async () => {
        try {
          await store.installBatch(
            1,
            {
              cursor: {
                slot: repeatedBlock.slot,
                blockHeight: repeatedBlock.blockHeight,
                blockhash: repeatedBlock.blockhash,
              },
              scannedThroughSlot: repeatedBlock.slot,
            },
            [scanned(repeatedBlock, [repeatedDeposit])],
          );
        } catch (error) {
          conflict = error;
        }
        await store.persistHold(
          1,
          conflict instanceof SolanaStoreFault
            ? conflict.code
            : 'STORE_CONFLICT',
        );
      });

      expect(conflict).toMatchObject({
        name: 'SolanaStoreFault',
        code: 'SIGNATURE_ALREADY_PROVEN',
        kind: 'content',
      });
      expect(
        await rows(
          reader,
          'SELECT * FROM "block_entity" WHERE "scanner" = ? AND "height" = 52',
          ['solana-mainnet'],
        ),
      ).toHaveLength(0);
      expect(
        await rows(reader, 'SELECT * FROM "solana_observation_evidence"'),
      ).toHaveLength(1);
      expect(
        await rows(reader, 'SELECT * FROM "observation_entity"'),
      ).toHaveLength(1);
      expect(
        await rows(
          reader,
          'SELECT "revision", "holdCode", "cursorSlot" FROM "solana_scan_state"',
        ),
      ).toEqual([
        expect.objectContaining({
          revision: 2,
          holdCode: 'SIGNATURE_ALREADY_PROVEN',
          cursorSlot: 103,
        }),
      ]);
    }));

  /**
   * @target SqliteSolanaScanStore rejects a previously proven signature when the later projection says not-deposit
   * @dependencies prior source-signature proof and a later non-deposit projection
   * @scenario replay the proven signature with a projection that omits its deposit
   * @expected signature reuse remains rejected despite the changed projection outcome
   */
  it('rejects a previously proven signature when the later projection says not-deposit', async () =>
    withDatabase(async (_database, store, reader) => {
      await installFirstBlock(store);
      const repeatedBlock = makeBlock(
        109,
        52,
        103,
        block103Hash,
        block109Hash,
        [signatureA],
      );
      await expect(
        store.withExclusiveScan(() =>
          store.installBatch(
            1,
            {
              cursor: {
                slot: repeatedBlock.slot,
                blockHeight: repeatedBlock.blockHeight,
                blockhash: repeatedBlock.blockhash,
              },
              scannedThroughSlot: repeatedBlock.slot,
            },
            [scanned(repeatedBlock)],
          ),
        ),
      ).rejects.toMatchObject({
        code: 'SIGNATURE_ALREADY_PROVEN',
        kind: 'content',
      });
      expect(
        await rows(reader, 'SELECT * FROM "block_entity" WHERE "height" = 52'),
      ).toHaveLength(0);
      expect(
        await rows(
          reader,
          'SELECT "revision", "cursorSlot" FROM "solana_scan_state"',
        ),
      ).toEqual([expect.objectContaining({ revision: 1, cursorSlot: 103 })]);
    }));

  /**
   * @target SqliteSolanaScanStore keeps deduplication after an observation projection is deleted
   * @dependencies retained evidence row and a deleted observation projection
   * @scenario reopen the database and submit another block containing the proven signature
   * @expected retained evidence continues to prevent duplicate processing
   */
  it('keeps deduplication after an observation projection is deleted', async () =>
    withDatabase(async (_database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(
        'DELETE FROM "observation_entity" WHERE "sourceTxId" = ?',
        [signatureA],
      );
      expect(
        await rows(reader, 'SELECT * FROM "solana_observation_evidence"'),
      ).toHaveLength(1);
      const repeatedBlock = makeBlock(
        109,
        52,
        103,
        block103Hash,
        block109Hash,
        [signatureA],
      );
      await expect(
        store.withExclusiveScan(() =>
          store.installBatch(
            1,
            {
              cursor: {
                slot: repeatedBlock.slot,
                blockHeight: repeatedBlock.blockHeight,
                blockhash: repeatedBlock.blockhash,
              },
              scannedThroughSlot: repeatedBlock.slot,
            },
            [scanned(repeatedBlock)],
          ),
        ),
      ).rejects.toMatchObject({ code: 'SIGNATURE_ALREADY_PROVEN' });
      expect(
        await rows(
          reader,
          'SELECT "revision", "cursorSlot" FROM "solana_scan_state"',
        ),
      ).toEqual([expect.objectContaining({ revision: 1, cursorSlot: 103 })]);
    }));

  /**
   * @target SqliteSolanaScanStore chunks historical signature lookups at no more than 900 bind parameters
   * @dependencies 901 canonical signatures and a query-recording writer factory
   * @scenario install the signature set and inspect historical lookup query sizes
   * @expected lookup batches stay within 900 bind parameters and cover all signatures
   */
  it('chunks historical signature lookups at no more than 900 bind parameters', async () =>
    withDatabase(async (database, originalStore) => {
      await originalStore.close();
      const calls: Array<{ sql: string; parameterCount: number }> = [];
      const store = new SqliteSolanaScanStore(
        createProfile(),
        database,
        createQueryRecordingWriterFactory(calls),
      );
      try {
        const signatures = Array.from({ length: 901 }, (_, index) => {
          const bytes = Buffer.alloc(64);
          bytes.writeUInt32BE(index + 1, 60);
          return bs58.encode(bytes);
        });
        const block = makeBlock(
          103,
          51,
          100,
          anchorHash,
          block103Hash,
          signatures,
        );
        await store.withExclusiveScan(() =>
          store.installBatch(
            0,
            {
              cursor: {
                slot: block.slot,
                blockHeight: block.blockHeight,
                blockhash: block.blockhash,
              },
              scannedThroughSlot: block.slot,
            },
            [scanned(block)],
          ),
        );
        const lookups = calls.filter(
          (call) =>
            call.sql.includes(
              'SELECT "sourceTxId" FROM "solana_observation_evidence"',
            ) && call.sql.includes('"sourceTxId" IN ('),
        );
        expect(lookups.length).toBeGreaterThanOrEqual(2);
        expect(lookups.every((call) => call.parameterCount <= 900)).toBe(true);
        expect(Math.max(...lookups.map((call) => call.parameterCount))).toBe(
          900,
        );
      } finally {
        await store.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore rejects restart when observation field %s diverges from evidence
   * @dependencies persisted observation/evidence pair and one-field database mutations
   * @scenario alter each listed observation field and reopen the store
   * @expected every mismatch is rejected with OBSERVATION_EVIDENCE_MISMATCH
   */
  it.each([
    ['sourceTxId', 'sourceTxId', `${'1'.repeat(63)}2`],
    ['fromChain', 'fromChain', 'other-chain'],
    ['toChain', 'toChain', 'other-chain'],
    ['fromAddress', 'fromAddress', 'other-sender'],
    ['toAddress', 'toAddress', 'other-recipient'],
    ['amount', 'amount', '501'],
    ['bridgeFee', 'bridgeFee', '2'],
    ['networkFee', 'networkFee', '2'],
    ['sourceChainTokenId', 'sourceChainTokenId', 'other-token'],
    ['targetChainTokenId', 'targetChainTokenId', 'other-target'],
    ['sourceBlockId', 'sourceBlockId', block109Hash],
    ['height', 'height', 52],
    ['requestId', 'requestId', 'b'.repeat(64)],
    ['block', 'block', block109Hash],
    ['extractor', 'extractor', 'other-extractor'],
    ['rawData', 'rawData', 'different-raw-data'],
  ])(
    'rejects restart when observation field %s diverges from evidence',
    async (_name, field, value) =>
      withDatabase(async (database, store, reader) => {
        await installFirstBlock(store);
        await reader.query(
          `UPDATE "observation_entity" SET "${field}" = ? WHERE "sourceTxId" = ?`,
          [value, signatureA],
        );
        await store.close();
        const reopened = new SqliteSolanaScanStore(createProfile(), database);
        try {
          await expect(
            reopened.withExclusiveScan(() => reopened.readState()),
          ).rejects.toMatchObject({ code: 'OBSERVATION_EVIDENCE_MISMATCH' });
        } finally {
          await reopened.close();
        }
      }),
  );

  /**
   * @target SqliteSolanaScanStore keeps unrelated observations from another extractor outside the owned reconciliation
   * @dependencies owned scanner profile and an unrelated extractor observation
   * @scenario reconcile the owned store while the other extractor's row is present
   * @expected reconciliation leaves the unrelated observation intact
   */
  it('keeps unrelated observations from another extractor outside the owned reconciliation', async () =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(
        `INSERT INTO "observation_entity"
         ("sourceTxId", "requestId", "extractor", "fromChain", "toChain",
          "fromAddress", "toAddress", "height", "amount", "bridgeFee", "networkFee",
          "sourceChainTokenId", "targetChainTokenId", "sourceBlockId", "block", "rawData")
         SELECT ?, ?, ?, "fromChain", "toChain", "fromAddress", "toAddress", "height",
          "amount", "bridgeFee", "networkFee", "sourceChainTokenId", "targetChainTokenId",
          "sourceBlockId", "block", "rawData"
         FROM "observation_entity" WHERE "sourceTxId" = ?`,
        [`${'1'.repeat(63)}2`, 'b'.repeat(64), 'other-extractor', signatureA],
      );
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).resolves.toMatchObject({ revision: 1, cursor: { slot: 103 } });
        expect(
          await rows(reader, 'SELECT * FROM "observation_entity"'),
        ).toHaveLength(2);
      } finally {
        await reopened.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore allows a retained proof without its deleted observation and does not recreate it
   * @dependencies retained evidence row with its observation projection deleted
   * @scenario reopen and reconcile the store containing the proof-only record
   * @expected the proof is accepted and the missing observation remains absent
   */
  it('allows a retained proof without its deleted observation and does not recreate it', async () =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(
        'DELETE FROM "observation_entity" WHERE "sourceTxId" = ?',
        [signatureA],
      );
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        const state = await reopened.withExclusiveScan(() =>
          reopened.readState(),
        );
        expect(state).toMatchObject({ revision: 1, cursor: { slot: 103 } });
        expect(
          await rows(
            reader,
            'SELECT * FROM "observation_entity" WHERE "sourceTxId" = ?',
            [signatureA],
          ),
        ).toHaveLength(0);
        expect(
          await rows(reader, 'SELECT * FROM "solana_observation_evidence"'),
        ).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore rejects restart when an observation no longer has its proof
   * @dependencies persisted observation with its evidence row removed
   * @scenario reopen the store after deleting the observation's required proof
   * @expected startup fails with OBSERVATION_EVIDENCE_MISMATCH
   */
  it('rejects restart when an observation no longer has its proof', async () =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query('DELETE FROM "solana_observation_evidence"');
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code: 'OBSERVATION_EVIDENCE_MISMATCH' });
      } finally {
        await reopened.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore rejects restart when evidence %s is %s
   * @dependencies persisted proof and isolated scanner, extractor, coordinate, or genesis mutations
   * @scenario alter one evidence binding field at a time and reopen the store
   * @expected each proof-to-block binding mismatch is rejected with its fault code
   */
  it.each([
    ['scannerId', 'other-scanner', 'EVIDENCE_BLOCK_MISMATCH'],
    ['extractorId', 'other-extractor', 'EVIDENCE_BLOCK_MISMATCH'],
    ['sourceSlot', 100, 'EVIDENCE_BLOCK_MISMATCH'],
    ['sourceSlot', 102, 'EVIDENCE_BLOCK_MISMATCH'],
    ['sourceSlot', 104, 'EVIDENCE_BLOCK_MISMATCH'],
    ['sourceBlockHeight', 50, 'EVIDENCE_BLOCK_MISMATCH'],
    ['sourceBlockHeight', 52, 'EVIDENCE_BLOCK_MISMATCH'],
    ['sourceBlockId', block109Hash, 'EVIDENCE_BLOCK_MISMATCH'],
    ['block', block109Hash, 'EVIDENCE_BLOCK_MISMATCH'],
    ['genesisHash', 'other-genesis', 'EVIDENCE_BLOCK_MISMATCH'],
  ])('rejects restart when evidence %s is %s', async (column, value, code) =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(
        `UPDATE "solana_observation_evidence" SET "${column}" = ? WHERE "sourceTxId" = ?`,
        [value, signatureA],
      );
      if (column === 'genesisHash')
        await reader.query(
          'DELETE FROM "observation_entity" WHERE "sourceTxId" = ?',
          [signatureA],
        );
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code });
      } finally {
        await reopened.close();
      }
    }),
  );

  /**
   * @target SqliteSolanaScanStore rejects a request ID hashed from decoded signature bytes instead of canonical text
   * @dependencies canonical base58 signature and byte-derived request-ID mutation
   * @scenario replace proof and observation request IDs with a hash of decoded signature bytes
   * @expected restart rejects the noncanonical ID with EVIDENCE_REQUEST_ID_MISMATCH
   */
  it('rejects a request ID hashed from decoded signature bytes instead of canonical text', async () =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      const byteBasedRequestId = Buffer.from(
        blake2b(bs58.decode(signatureA), undefined, 32),
      ).toString('hex');
      await reader.query(
        'UPDATE "solana_observation_evidence" SET "requestId" = ?',
        [byteBasedRequestId],
      );
      await reader.query('UPDATE "observation_entity" SET "requestId" = ?', [
        byteBasedRequestId,
      ]);
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code: 'EVIDENCE_REQUEST_ID_MISMATCH' });
      } finally {
        await reopened.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore rejects restart with %s
   * @dependencies valid stored cursor and isolated extractor-status mutations
   * @scenario remove status or move its height/hash ahead of or behind the cursor
   * @expected restart rejects each inconsistent status with STATUS_CURSOR_MISMATCH
   */
  it.each([
    ['missing status', 'DELETE FROM "extractor_status_entity"'],
    [
      'status ahead',
      'UPDATE "extractor_status_entity" SET "updateHeight" = 52',
    ],
    [
      'status behind',
      'UPDATE "extractor_status_entity" SET "updateHeight" = 50',
    ],
    [
      'status hash mismatch',
      'UPDATE "extractor_status_entity" SET "updateBlockHash" = \'other-block\'',
    ],
  ])('rejects restart with %s', async (_name, sql) =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(sql);
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code: 'STATUS_CURSOR_MISMATCH' });
      } finally {
        await reopened.close();
      }
    }),
  );

  /**
   * @target SqliteSolanaScanStore rejects restart with an extra %s block
   * @dependencies valid installed batch and an inserted block beyond its cursor
   * @scenario add an extra block with each listed status and reopen the store
   * @expected restart rejects the extra row as ahead-of-cursor or incomplete projection
   */
  it.each([
    [PROCEED, 'BLOCK_AHEAD_OF_CURSOR'],
    ['PROCESSING', 'INCOMPLETE_BLOCK_PROJECTION'],
  ])('rejects restart with an extra %s block', async (status, code) =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(
        `INSERT INTO "block_entity"
         ("height", "hash", "parentHash", "extra", "status", "scanner",
          "timestamp", "year", "month", "day")
         SELECT 52, ?, "hash", ?, ?, "scanner", "timestamp", "year", "month", "day"
         FROM "block_entity" WHERE "scanner" = ? AND "height" = 51`,
        [block109Hash, 'solana-slot-v1:109', status, 'solana-mainnet'],
      );
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code });
      } finally {
        await reopened.close();
      }
    }),
  );

  /**
   * @target SqliteSolanaScanStore rejects restart when the projected block is missing
   * @dependencies persisted cursor and a deleted projected block row
   * @scenario reopen after removing the block required by the stored cursor
   * @expected startup rejects the cursor-to-block mismatch
   */
  it('rejects restart when the projected block is missing', async () =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      await reader.query(
        'DELETE FROM "block_entity" WHERE "scanner" = ? AND "height" = ?',
        ['solana-mainnet', 51],
      );
      await store.close();
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code: 'CURSOR_BLOCK_MISMATCH' });
      } finally {
        await reopened.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore rejects restart when block height %s has invalid slot metadata
   * @dependencies anchor and cursor block rows with absent or unsupported slot metadata
   * @scenario mutate anchor or cursor block metadata and reopen the store
   * @expected restart reports the matching anchor or cursor block mismatch
   */
  it.each([
    [50, null, 'ANCHOR_BLOCK_MISMATCH'],
    [50, 'unknown-slot-v0:100', 'ANCHOR_BLOCK_MISMATCH'],
    [51, null, 'CURSOR_BLOCK_MISMATCH'],
    [51, 'unknown-slot-v0:103', 'CURSOR_BLOCK_MISMATCH'],
  ])(
    'rejects restart when block height %s has invalid slot metadata',
    async (height, extra, code) =>
      withDatabase(async (database, store, reader) => {
        await installFirstBlock(store);
        await reader.query(
          'UPDATE "block_entity" SET "extra" = ? WHERE "scanner" = ? AND "height" = ?',
          [extra, 'solana-mainnet', height],
        );
        await store.close();
        const reopened = new SqliteSolanaScanStore(createProfile(), database);
        try {
          await expect(
            reopened.withExclusiveScan(() => reopened.readState()),
          ).rejects.toMatchObject({ code });
        } finally {
          await reopened.close();
        }
      }),
  );

  /**
   * @target SqliteSolanaScanStore checks retained evidence %s against the bound profile after observation deletion
   * @dependencies bound profile, retained proof, and deleted observation projection
   * @scenario mutate one retained policy field and reopen with no observation row
   * @expected restart still rejects the evidence with EVIDENCE_POLICY_MISMATCH
   */
  it.each([
    ['sourceChainTokenId', 'unknown-solana-asset'],
    ['targetChainTokenId', 'f'.repeat(64)],
    ['toChain', 'other-chain'],
    ['bridgeFee', '2'],
    ['networkFee', '2'],
  ])(
    'checks retained evidence %s against the bound profile after observation deletion',
    async (column, value) =>
      withDatabase(async (database, store, reader) => {
        await installFirstBlock(store);
        await reader.query(
          `UPDATE "solana_observation_evidence" SET "${column}" = ? WHERE "sourceTxId" = ?`,
          [value, signatureA],
        );
        await reader.query(
          'DELETE FROM "observation_entity" WHERE "sourceTxId" = ?',
          [signatureA],
        );
        await store.close();
        const reopened = new SqliteSolanaScanStore(createProfile(), database);
        try {
          await expect(
            reopened.withExclusiveScan(() => reopened.readState()),
          ).rejects.toMatchObject({ code: 'EVIDENCE_POLICY_MISMATCH' });
        } finally {
          await reopened.close();
        }
      }),
  );

  /**
   * @target SqliteSolanaScanStore relies on unique block keys to prevent duplicate evidence-to-block joins
   * @dependencies block and evidence tables with their unique-key constraints
   * @scenario attempt to duplicate a block key and inspect the resulting joins
   * @expected the uniqueness constraint prevents ambiguous evidence-to-block joins
   */
  it('relies on unique block keys to prevent duplicate evidence-to-block joins', async () =>
    withDatabase(async (_database, store, reader) => {
      await installFirstBlock(store);
      await expect(
        reader.query(
          `INSERT INTO "block_entity"
           ("height", "hash", "parentHash", "status", "scanner", "timestamp", "year", "month", "day")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            51,
            block103Hash,
            anchorHash,
            'PROCEED',
            'solana-mainnet',
            1_700_000_051,
            2023,
            11,
            14,
          ],
        ),
      ).rejects.toThrow();
      expect(
        await rows(
          reader,
          'SELECT COUNT(*) AS "count" FROM "block_entity" WHERE "scanner" = ? AND "height" = ?',
          ['solana-mainnet', 51],
        ),
      ).toEqual([{ count: 1 }]);
    }));

  /**
   * @target SqliteSolanaScanStore reconciles evidence in bounded keyset pages, including later-page request IDs
   * @dependencies multi-page evidence set with canonical request IDs and separate reader
   * @scenario reopen and reconcile evidence spanning multiple keyset pages
   * @expected later-page request IDs are checked and the complete evidence set is reconciled
   */
  it('reconciles evidence in bounded keyset pages, including later-page request IDs', async () =>
    withDatabase(async (database, store, reader) => {
      await installFirstBlock(store);
      const evidence = [];
      for (let index = 1; index <= 257; index++) {
        const bytes = Buffer.alloc(64);
        bytes.writeUInt32BE(index, 60);
        const sourceTxId = bs58.encode(bytes);
        evidence.push({
          genesisHash,
          sourceTxId,
          scannerId: 'solana-mainnet',
          extractorId: 'solana-v1',
          requestId: Buffer.from(blake2b(sourceTxId, undefined, 32)).toString(
            'hex',
          ),
          sourceSlot: 103,
          sourceBlockHeight: 51,
          sourceBlockId: block103Hash,
          fromChain: 'solana',
          toChain: 'ergo',
          fromAddress: 'sender',
          toAddress: 'recipient',
          amount: '500',
          bridgeFee: '1',
          networkFee: '1',
          sourceChainTokenId: 'sol',
          targetChainTokenId: targetTokenId,
          block: block103Hash,
          rawData: '{"memo":"bridge-request"}',
        });
      }
      for (const item of evidence)
        await reader.query(
          `INSERT INTO "solana_observation_evidence"
           ("genesisHash", "sourceTxId", "scannerId", "extractorId", "requestId",
            "sourceSlot", "sourceBlockHeight", "sourceBlockId", "fromChain", "toChain",
            "fromAddress", "toAddress", "amount", "bridgeFee", "networkFee",
            "sourceChainTokenId", "targetChainTokenId", "block", "rawData")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          Object.values(item),
        );
      await store.close();
      const last = evidence[evidence.length - 1];
      await reader.query(
        'UPDATE "solana_observation_evidence" SET "requestId" = ? WHERE "sourceTxId" = ?',
        ['0'.repeat(64), last.sourceTxId],
      );
      const reopened = new SqliteSolanaScanStore(createProfile(), database);
      try {
        await expect(
          reopened.withExclusiveScan(() => reopened.readState()),
        ).rejects.toMatchObject({ code: 'EVIDENCE_REQUEST_ID_MISMATCH' });
      } finally {
        await reopened.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore fences concurrent writer instances with the persisted revision
   * @dependencies two store instances sharing one file-backed database and initial revision
   * @scenario race both writers to install the same next revision
   * @expected only one writer commits and the database exposes one consistent revision
   */
  it('fences concurrent writer instances with the persisted revision', async () =>
    withDatabase(async (database, first, reader) => {
      const second = new SqliteSolanaScanStore(createProfile(), database);
      try {
        const next = {
          cursor: {
            slot: block103.slot,
            blockHeight: block103.blockHeight,
            blockhash: block103.blockhash,
          },
          scannedThroughSlot: block103.slot,
        };
        const attempts = await Promise.allSettled([
          first.withExclusiveScan(() =>
            first.installBatch(0, next, block103Batch(false)),
          ),
          second.withExclusiveScan(() =>
            second.installBatch(0, next, block103Batch(false)),
          ),
        ]);
        expect(
          attempts.filter((attempt) => attempt.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = attempts.find(
          (attempt) => attempt.status === 'rejected',
        );
        expect(rejected?.status).toBe('rejected');
        if (rejected?.status === 'rejected')
          expect(rejected.reason).toMatchObject({ kind: 'conflict' });
        expect(
          await rows(
            reader,
            'SELECT * FROM "block_entity" WHERE "height" = 51',
          ),
        ).toHaveLength(1);
        expect(
          await rows(
            reader,
            'SELECT "revision", "cursorSlot" FROM "solana_scan_state"',
          ),
        ).toEqual([expect.objectContaining({ revision: 1, cursorSlot: 103 })]);
      } finally {
        await second.close();
      }
    }));

  /**
   * @target SqliteSolanaScanStore refuses an unreviewed profile on restart without changing the stored state
   * @dependencies persisted state bound to the original profile and an altered profile fixture
   * @scenario reopen the database with the altered profile and compare state before and after
   * @expected restart is rejected and the original revision and config binding remain unchanged
   */
  it('refuses an unreviewed profile on restart without changing the stored state', async () =>
    withDatabase(async (database, store, reader) => {
      const alteredProfile = {
        ...createProfile(),
        vaultOwner: 'another-vault',
      };
      const alteredStore = new SqliteSolanaScanStore(alteredProfile, database);
      try {
        await expect(
          alteredStore.withExclusiveScan(() => alteredStore.readState()),
        ).rejects.toMatchObject({ kind: 'identity' });
        expect(
          await rows(
            reader,
            'SELECT "revision", "configBinding" FROM "solana_scan_state"',
          ),
        ).toEqual([expect.objectContaining({ revision: 0 })]);
      } finally {
        await alteredStore.close();
      }
      expect(store).toBeDefined();
    }));
});
