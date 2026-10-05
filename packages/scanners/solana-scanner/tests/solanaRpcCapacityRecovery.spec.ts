import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DataSource } from '@rosen-bridge/extended-typeorm';

import type { SolanaProjectorProfile } from '../lib/profile';
import { HttpSolanaRpc } from '../lib/rpc/httpSolanaRpc';
import { SolanaFinalizedScanner } from '../lib/scanner/solanaFinalizedScanner';
import {
  configureSolanaSqliteWriter,
  createSolanaSqliteWriterDataSource,
} from '../lib/store/solanaSqliteDataSource';
import { SqliteSolanaScanStore } from '../lib/store/sqliteSolanaScanStore';
import type { SolanaBlockProjector } from '../lib/types';

const genesisHash = '1'.repeat(32);
const anchorHash = '1'.repeat(32);
const anchorParentHash = `${'1'.repeat(31)}4`;
const blockHash = `${'1'.repeat(31)}2`;
const signature = '1'.repeat(64);
const targetTokenId = 'a'.repeat(64);
const lowResponseBytes = 1024;
const recoveryResponseBytes = 2 * 1024 * 1024;
const scannerResponseBytes = 3 * 1024 * 1024;
const responsePadding = 'x'.repeat(1_100_000);

const projectorProfile: SolanaProjectorProfile = {
  genesisHash,
  destinationChain: 'ergo',
  destinationNetwork: 'mainnet',
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
  projectorVersion: 'capacity-recovery-fixture-v1',
};

const identity = {
  scannerId: 'solana-capacity-recovery',
  extractorId: 'solana-capacity-recovery-fixture',
  anchor: { slot: 100, blockHeight: 50, blockhash: anchorHash },
};

const anchorBlock = {
  ...identity.anchor,
  parentSlot: 99,
  previousBlockhash: anchorParentHash,
  blockTime: 1_700_000_050,
  transactions: [],
};

const blockResult = {
  blockhash: blockHash,
  blockHeight: 51,
  parentSlot: 100,
  previousBlockhash: anchorHash,
  blockTime: 1_700_000_051,
  transactions: [{ transaction: { signatures: [signature] } }],
  padding: responsePadding,
};

const serializedBlockResult = JSON.stringify(blockResult);
const profile = { ...projectorProfile, ...identity };
/** Returns a unique temporary SQLite path for a recovery case. */
const databasePath = (): string =>
  join(tmpdir(), `rosen-solana-capacity-${randomUUID()}.sqlite`);

/** Removes the test database and any SQLite sidecar files. */
const cleanupDatabase = async (database: string): Promise<void> => {
  await Promise.all(
    ['', '-journal', '-wal', '-shm'].map((suffix) =>
      rm(`${database}${suffix}`, { force: true }),
    ),
  );
};

/** Applies the scanner's SQLite migrations and closes the migration connection. */
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

/** Opens a reader connection for inspecting persisted scanner state. */
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

/** Reads the persisted cursor, block, evidence, observation, and extractor status. */
const snapshot = async (reader: DataSource) => ({
  state: await reader.query(
    'SELECT "revision", "cursorSlot", "cursorBlockHeight", "cursorBlockhash", "scannedThroughSlot", "holdCode" FROM "solana_scan_state" WHERE "id" = 1',
  ),
  blocks: await reader.query(
    'SELECT "height", "hash", "status", "extra" FROM "block_entity" WHERE "scanner" = ? ORDER BY "height"',
    [identity.scannerId],
  ),
  evidence: await reader.query(
    'SELECT "sourceTxId" FROM "solana_observation_evidence"',
  ),
  observations: await reader.query(
    'SELECT "sourceTxId" FROM "observation_entity"',
  ),
  status: await reader.query(
    'SELECT "updateHeight", "updateBlockHash" FROM "extractor_status_entity" WHERE "scannerId" = ? AND "extractorId" = ?',
    [identity.scannerId, identity.extractorId],
  ),
});

/** Creates a deterministic RPC fetcher and records each observed block response. */
const createFetcher =
  (observedBlockResults: string[]): typeof fetch =>
  async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: string;
      method: string;
      params: unknown[];
    };
    let result: unknown;
    switch (request.method) {
      case 'getGenesisHash':
        result = genesisHash;
        break;
      case 'getFirstAvailableBlock':
        result = 0;
        break;
      case 'getSlot':
        result = 103;
        break;
      case 'getBlocks':
        result = [103];
        break;
      case 'getBlock': {
        const slot = request.params[0];
        if (slot === identity.anchor.slot) {
          result = anchorBlock;
          break;
        }
        if (slot !== 103) throw new Error('UNEXPECTED_TEST_SLOT');
        observedBlockResults.push(JSON.stringify(blockResult));
        result = blockResult;
        break;
      }
      default:
        throw new Error('UNEXPECTED_TEST_METHOD');
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

/** Projects the fixed RPC block into one bound Ergo deposit observation. */
const createProjector = (): SolanaBlockProjector => ({
  getResolvedProfile: () => projectorProfile,
  getBlockWithContext: (raw, context) => {
    const response = JSON.parse(raw) as {
      result: {
        transactions: Array<{ transaction: { signatures: string[] } }>;
      };
    };
    const sourceTxId =
      response.result.transactions[0]?.transaction.signatures[0];
    if (sourceTxId !== signature || context.slot !== 103)
      return { type: 'unavailable', reason: 'FIXTURE_BINDING' };
    return {
      type: 'block',
      transactions: [
        {
          transactionIndex: 0,
          signature,
          outcome: {
            type: 'deposit',
            context: {
              clusterGenesisHash: genesisHash,
              sourceTxId: signature,
              sourceSlot: 103,
              sourceBlockhash: blockHash,
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
              sourceTxId: signature,
              rawData: '{"memo":"capacity-recovery"}',
            },
          },
        },
      ],
    };
  },
});

/** Builds the finalized scanner with the requested HTTP response bound. */
const createScanner = (
  store: SqliteSolanaScanStore,
  maxResponseBytes: number,
  observedBlockResults: string[],
) => {
  const rpc = new HttpSolanaRpc({
    endpoint: 'https://fixture.invalid/rpc',
    fetcher: createFetcher(observedBlockResults),
    maxResponseBytes,
  });
  const scanner = new SolanaFinalizedScanner({
    rpc,
    store,
    profile,
    projector: createProjector(),
    bounds: { maxBlockResponseBytes: scannerResponseBytes },
  });
  return scanner;
};

describe('Solana RPC capacity recovery with SQLite', () => {
  /**
   * @target SolanaFinalizedScanner.update retries the same bounded RPC payload after reopening without skipping its block
   * @dependencies local injected RPC transport, finalized scanner and file-backed SQLite store
   * @scenario retry the identical oversized block after reopening the same database with a larger HTTP bound
   * @expected the first attempt installs nothing and the retry installs one observation with the cursor atomically advanced
   */
  it('retries the same bounded RPC payload after reopening without skipping its block', async () => {
    expect(Buffer.byteLength(serializedBlockResult, 'utf8')).toBeGreaterThan(
      lowResponseBytes,
    );
    expect(Buffer.byteLength(serializedBlockResult, 'utf8')).toBeLessThan(
      recoveryResponseBytes,
    );
    expect(scannerResponseBytes).toBeGreaterThan(recoveryResponseBytes);

    const database = databasePath();
    let store: SqliteSolanaScanStore | undefined;
    let reader: DataSource | undefined;
    const observedBlockResults: string[] = [];
    try {
      await migrateDatabase(database);
      store = new SqliteSolanaScanStore(profile, database);
      await store.withExclusiveScan(() =>
        store!.initialize({
          ...anchorBlock,
          commitment: 'finalized',
          rawResponse: JSON.stringify({ result: anchorBlock }),
        }),
      );
      reader = await openReader(database);
      const before = await snapshot(reader);
      const first = createScanner(
        store,
        lowResponseBytes,
        observedBlockResults,
      );

      await expect(first.update()).rejects.toMatchObject({
        name: 'SolanaRpcUnavailableError',
        code: 'RPC_RESPONSE_BOUND',
      });
      expect(await snapshot(reader)).toEqual(before);
      expect(before.state).toMatchObject([
        {
          revision: 0,
          cursorSlot: identity.anchor.slot,
          cursorBlockHeight: identity.anchor.blockHeight,
          scannedThroughSlot: identity.anchor.slot,
          holdCode: null,
        },
      ]);
      expect(before.observations).toEqual([]);
      expect(before.evidence).toEqual([]);

      await store.close();
      store = new SqliteSolanaScanStore(profile, database);
      expect(await snapshot(reader)).toEqual(before);
      const retry = createScanner(
        store,
        recoveryResponseBytes,
        observedBlockResults,
      );

      await expect(retry.update()).resolves.toMatchObject({
        status: 'caught-up',
        blocks: 1,
        newObservations: 1,
        revision: 1,
        cursor: { slot: 103, blockHeight: 51, blockhash: blockHash },
        scannedThroughSlot: 103,
      });
      const afterRecovery = await snapshot(reader);
      expect(afterRecovery.state).toMatchObject([
        {
          revision: 1,
          cursorSlot: 103,
          cursorBlockHeight: 51,
          cursorBlockhash: blockHash,
          scannedThroughSlot: 103,
          holdCode: null,
        },
      ]);
      expect(afterRecovery.blocks).toHaveLength(before.blocks.length + 1);
      expect(afterRecovery.evidence).toEqual([{ sourceTxId: signature }]);
      expect(afterRecovery.observations).toEqual([{ sourceTxId: signature }]);
      expect(afterRecovery.status).toEqual([
        { updateHeight: 51, updateBlockHash: blockHash },
      ]);

      await expect(retry.update()).resolves.toMatchObject({
        status: 'caught-up',
        pages: 0,
        blocks: 0,
        newObservations: 0,
        revision: 1,
      });
      expect(await snapshot(reader)).toEqual(afterRecovery);
      expect(observedBlockResults.length).toBeGreaterThanOrEqual(3);
      expect(
        observedBlockResults.every((body) => body === serializedBlockResult),
      ).toBe(true);
    } finally {
      if (store) await store.close();
      if (reader?.isInitialized) await reader.destroy();
      await cleanupDatabase(database);
    }
  });
});
