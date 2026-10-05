import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataSource } from '@rosen-bridge/extended-typeorm';

import { SolanaScanProfile } from '../../lib/profile';
import {
  configureSolanaSqliteWriter,
  createSolanaSqliteWriterDataSource,
} from '../../lib/store/solanaSqliteDataSource';
import { SqliteSolanaScanStore } from '../../lib/store/sqliteSolanaScanStore';
import {
  SolanaDepositCandidate,
  SolanaRpcBlock,
  SolanaScannedBlock,
} from '../../lib/types';

export const genesisHash = '1'.repeat(32);
export const anchorHash = '1'.repeat(32);
export const anchorParentHash = '9'.repeat(32);
export const nextBlockHash = `${'1'.repeat(31)}2`;
export const signatureA = '1'.repeat(64);
export const destinationTokenId = 'a'.repeat(64);

/** Returns the fixed native-SOL profile shared by process workers and tests. */
export const createProfile = (): SolanaScanProfile => ({
  genesisHash,
  destinationChain: 'ergo',
  destinationNetwork: 'mainnet',
  scannerId: 'solana-mainnet',
  extractorId: 'solana-v1',
  vaultOwner: '11111111111111111111111111111111',
  assets: [
    {
      assetId: 'sol',
      programId: '11111111111111111111111111111111',
      mint: null,
      vaultTokenAccount: null,
      sourceDecimals: 9,
      destinationDecimals: 9,
      destinationTokenId,
      minAmount: '1',
      maxAmount: '1000000000000',
      networkFee: '1',
      bridgeFee: '1',
    },
  ],
  memoVersion: 1,
  projectorVersion: 'process-fixture-v1',
  anchor: { slot: 100, blockHeight: 50, blockhash: anchorHash },
});

/** Builds a finalized block fixture from its stable slot and hash coordinates. */
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
  blockTime: 1_700_000_000 + blockHeight,
  commitment: 'finalized',
  transactions: signatures.map((signature, transactionIndex) => ({
    signature,
    transactionIndex,
  })),
  rawResponse: JSON.stringify({ slot, blockhash }),
});

export const anchorBlock = makeBlock(
  100,
  50,
  99,
  anchorParentHash,
  anchorHash,
  [],
);

export const nextBlock = makeBlock(103, 51, 100, anchorHash, nextBlockHash, [
  signatureA,
]);

const deposit: SolanaDepositCandidate = {
  signature: signatureA,
  context: {
    clusterGenesisHash: genesisHash,
    sourceTxId: signatureA,
    sourceSlot: nextBlock.slot,
    sourceBlockhash: nextBlock.blockhash,
  },
  data: {
    toChain: 'ergo',
    toAddress: 'recipient',
    bridgeFee: '1',
    networkFee: '1',
    fromAddress: 'sender',
    sourceChainTokenId: 'sol',
    amount: '500',
    targetChainTokenId: destinationTokenId,
    sourceTxId: signatureA,
    rawData: '{"memo":"bridge-request"}',
  },
};

const scannedBlock: SolanaScannedBlock['block'] = {
  slot: nextBlock.slot,
  blockHeight: nextBlock.blockHeight,
  blockhash: nextBlock.blockhash,
  parentSlot: nextBlock.parentSlot,
  previousBlockhash: nextBlock.previousBlockhash,
  blockTime: nextBlock.blockTime,
  commitment: nextBlock.commitment,
  transactions: nextBlock.transactions,
};

/** Returns the fixed next-block batch containing its deposit candidate. */
export const nextBatch = (): SolanaScannedBlock[] => [
  { block: scannedBlock, deposits: [deposit] },
];

/** Returns a unique temporary SQLite path for a process test. */
export const tempDatabase = (): string =>
  join(tmpdir(), `rosen-solana-process-${randomUUID()}.sqlite`);

/** Removes the process-test database and its SQLite sidecar files. */
export const cleanupDatabase = async (database: string): Promise<void> => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    ['', '-journal', '-wal', '-shm'].map((suffix) =>
      rm(`${database}${suffix}`, { force: true }),
    ),
  );
};

/** Migrates the database and installs its anchor checkpoint. */
export const initializeDatabase = async (database: string): Promise<void> => {
  const migrator = createSolanaSqliteWriterDataSource(database);
  try {
    await migrator.initialize();
    await configureSolanaSqliteWriter(migrator);
    await migrator.runMigrations();
  } finally {
    if (migrator.isInitialized) await migrator.destroy();
  }

  const store = new SqliteSolanaScanStore(createProfile(), database);
  try {
    await store.withExclusiveScan(() => store.initialize(anchorBlock));
  } finally {
    await store.close();
  }
};

/** Opens an independent reader for inspecting committed SQLite projections. */
export const openReader = async (database: string): Promise<DataSource> => {
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
