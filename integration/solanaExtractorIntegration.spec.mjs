import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const execution = process.env.ROSEN_SOLANA_EXECUTION_ROOT;
if (!execution) throw new Error('ROSEN_SOLANA_EXECUTION_ROOT is required');
const scannerRoot = join(execution, 'repos/scanner');
const utilsRoot = join(execution, 'repos/utils');
const load = (path) => import(pathToFileURL(path).href);
const utilsRequire = createRequire(join(utilsRoot, 'package.json'));
const scannerRequire = createRequire(join(scannerRoot, 'package.json'));
const { TokenMap } = await load(utilsRequire.resolve('@rosen-bridge/tokens'));
const { AddressManager } = await load(utilsRequire.resolve('@rosen-bridge/address-manager'));
const { chainValidators, chainDecoders } = await load(utilsRequire.resolve('@rosen-bridge/address-codec'));
const { blake2b } = await load(scannerRequire.resolve('blakejs'));
const { default: bs58 } = await load(scannerRequire.resolve('bs58'));
const { SolanaRosenExtractor } = await load(join(utilsRoot, 'packages/rosen-extractor/lib/getRosenData/solana/solanaRosenExtractor.ts'));
const { SOLANA_NATIVE_TOKEN } = await load(join(utilsRoot, 'packages/rosen-extractor/lib/getRosenData/solana/constants.ts'));
const { makeFixture, replaceMemo, addresses } = await load(join(utilsRoot, 'packages/rosen-extractor/tests/getRosenData/solana/testData.ts'));
const scannerLib = join(scannerRoot, 'packages/scanners/solana-scanner/lib');
const { createSolanaScanner } = await load(join(scannerLib, 'scanner/createSolanaScanner.ts'));
const { SolanaFinalizedScanner } = await load(join(scannerLib, 'scanner/solanaFinalizedScanner.ts'));
const { createSolanaScanProfile } = await load(join(scannerLib, 'profile.ts'));
const { createSolanaSqliteWriterDataSource, configureSolanaSqliteWriter } = await load(join(scannerLib, 'store/solanaSqliteDataSource.ts'));
const { SqliteSolanaScanStore } = await load(join(scannerLib, 'store/sqliteSolanaScanStore.ts'));
AddressManager.init(chainValidators, chainDecoders);

const token = (tokenId, decimals) => ({ tokenId, decimals, name: 'fixture', type: 'native', residency: 'native', extra: {} });
const identity = {
  scannerId: 'solana-fixture', extractorId: 'solana-fixture-extractor',
  anchor: { slot: 99, blockHeight: 50, blockhash: addresses.recent },
};

async function fixture(kinds, scaleSpl = true) {
  const fixtures = kinds.map((kind, index) => {
    const f = makeFixture(kind);
    f.input.transaction.signatures[0] = bs58.encode(Buffer.alloc(64, 21 + index));
    if (f.input.history) f.input.history.sourceTxId = f.input.transaction.signatures[0];
    if (kind === 'SPL' && scaleSpl) {
      replaceMemo(f.input, { networkFee: '1000', bridgeFee: '2000' });
      Object.assign(f.config.assets[addresses.mint], { networkFee: '1000', bridgeFee: '2000' });
    }
    return f;
  });
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(fixtures.map((f) => f.fixtureKind === 'SOL'
    ? { solana: token(SOLANA_NATIVE_TOKEN, 9), ergo: token('cd'.repeat(32), 9) }
    : { solana: token(addresses.mint, 6), ergo: token('ab'.repeat(32), 9), ...(scaleSpl ? { cardano: token('fixture', 3) } : {}) }));
  const policy = {
    clusterGenesisHash: addresses.genesis, destinationNetwork: 'mainnet',
    vaultOwner: addresses.vault, assets: Object.assign({}, ...fixtures.map((f) => f.config.assets)),
  };
  const extractor = new SolanaRosenExtractor(policy, tokens);
  return { fixtures, extractor };
}

function blockOf(fixtures) {
  return {
    slot: 100, blockHeight: 51, blockhash: addresses.block, parentSlot: 99,
    previousBlockhash: addresses.recent, blockTime: 1700000000, commitment: 'finalized',
    transactions: fixtures.map((f, transactionIndex) => ({ signature: f.input.transaction.signatures[0], transactionIndex })),
    rawResponse: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
      blockhash: addresses.block,
      transactions: fixtures.map(({ input }) => ({ version: input.version, transaction: input.transaction, meta: input.meta })),
    } }),
  };
}

async function runJoin(fixtures, extractor, options = {}) {
  const block = blockOf(fixtures);
  const anchor = { ...block, ...identity.anchor, parentSlot: 98, previousBlockhash: addresses.lookup, transactions: [] };
  const database = join(tmpdir(), `rosen-solana-integration-${randomUUID()}.sqlite`);
  const migration = createSolanaSqliteWriterDataSource(database);
  await migration.initialize();
  await configureSolanaSqliteWriter(migration);
  await migration.runMigrations();
  await migration.destroy();
  const histories = fixtures.flatMap(({ input }) => input.history ? [{ signature: input.transaction.signatures[0], serializedHistory: JSON.stringify(input.history) }] : []);
  const historySource = { getBlockHistory: async (request) => ({ genesisHash: request.genesisHash, slot: request.slot, blockhash: request.blockhash, entries: options.missingHistory ? [] : histories }) };
  const rpc = {
    getGenesisHash: async () => addresses.genesis, getFirstAvailableBlock: async () => 0,
    getFinalizedHead: async () => ({ slot: 100, blockHeight: 51, blockhash: addresses.block, commitment: 'finalized' }),
    getBlock: async (slot) => slot === 99 ? anchor : block, getBlocks: async () => [100],
  };
  const { scanner, store } = createSolanaScanner({ rpc, projector: extractor, identity, database, historySource });
  try {
    let result, error;
    try { result = await scanner.update(); } catch (caught) { error = caught; }
    const state = await store.withExclusiveScan(() => store.readState());
    const reader = createSolanaSqliteWriterDataSource(database);
    await reader.initialize();
    try {
      return { result, error, state,
        observations: await reader.query('SELECT * FROM observation_entity ORDER BY sourceTxId'),
        evidence: await reader.query('SELECT * FROM solana_observation_evidence ORDER BY sourceTxId'),
      };
    } finally { await reader.destroy(); }
  } finally {
    await store.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) await rm(database + suffix, { force: true });
  }
}

describe('real extractor -> scanner -> SQLite', () => {
  it('rejects a separately configured real store without creating its database', async () => {
    const { extractor } = await fixture(['SOL']);
    const profile = createSolanaScanProfile(extractor.getResolvedProfile(), identity);
    const different = structuredClone(profile);
    different.vaultOwner = addresses.sponsor;
    const database = join(tmpdir(), `rosen-solana-mismatch-${randomUUID()}.sqlite`);
    const store = new SqliteSolanaScanStore(different, database);
    try {
      expect(() => new SolanaFinalizedScanner({ rpc: {}, store, projector: extractor, profile })).toThrow('STORE_PROFILE_BINDING');
      expect(existsSync(database)).toBe(false);
    } finally { await store.close(); }
  });
  it.each([['SOL', true], ['SPL', true], ['SPL', false]])('installs %s with scaled=%s and exact event/evidence joins', async (kind, scale) => {
    const { fixtures, extractor } = await fixture([kind], scale);
    const out = await runJoin(fixtures, extractor);
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ newObservations: 1, revision: 1, cursor: { slot: 100, blockHeight: 51 } });
    expect(out.state.holdCode).toBeNull();
    const data = extractor.getWithContext(JSON.stringify(fixtures[0].input));
    expect(data.type).toBe('deposit');
    const row = out.observations[0], proof = out.evidence[0];
    expect(row).toMatchObject({ ...data.data, fromChain: 'solana', height: 51, sourceBlockId: addresses.block, block: addresses.block });
    expect(row.requestId).toBe(Buffer.from(blake2b(row.sourceTxId, undefined, 32)).toString('hex'));
    for (const field of ['sourceTxId', 'fromChain', 'toChain', 'fromAddress', 'toAddress', 'amount', 'bridgeFee', 'networkFee', 'sourceChainTokenId', 'targetChainTokenId', 'sourceBlockId', 'block', 'rawData', 'requestId'])
      expect(proof[field], field).toBe(row[field]);
    expect(proof).toMatchObject({ sourceSlot: 100, sourceBlockHeight: row.height, genesisHash: addresses.genesis, extractorId: row.extractor, scannerId: identity.scannerId });
    if (kind === 'SPL' && scale) expect(row).toMatchObject({ amount: '1000', networkFee: '1', bridgeFee: '2' });
  });

  it('installs a mixed SOL/SPL block and ignores a complete unlisted SPL transfer', async () => {
    const { fixtures, extractor } = await fixture(['SOL', 'SPL']);
    const outside = makeFixture('SPL');
    const otherMint = addresses.lookup;
    outside.input.transaction.signatures[0] = bs58.encode(Buffer.alloc(64, 25));
    outside.input.transaction.message.accountKeys[3] = otherMint;
    replaceMemo(outside.input, { asset: otherMint });
    outside.input.meta.preTokenBalances.forEach((b) => { b.mint = otherMint; });
    outside.input.meta.postTokenBalances.forEach((b) => { b.mint = otherMint; });
    delete outside.input.history;
    const out = await runJoin([...fixtures, outside], extractor);
    expect(out.error).toBeUndefined();
    expect(out.result.newObservations).toBe(2);
    expect(out.state.holdCode).toBeNull();
  });

  it('holds an allowed SPL deposit with missing history without partially installing SOL', async () => {
    const { fixtures, extractor } = await fixture(['SOL', 'SPL']);
    const out = await runJoin(fixtures, extractor, { missingHistory: true });
    expect(out.error.code).toBe('PROJECTOR_HISTORY_BINDING');
    expect(out.state).toMatchObject({ cursor: identity.anchor, holdCode: 'PROJECTOR_HISTORY_BINDING' });
    expect(out.observations).toEqual([]);
    expect(out.evidence).toEqual([]);
  });

  it.each([
    ['vault', (p) => { p.vaultOwner = addresses.sponsor; }],
    ['cap', (p) => { p.assets[0].maxAmount = '2'; }],
    ['mint', (p) => { p.assets[0].mint = addresses.lookup; }],
    ['vault token', (p) => { p.assets[0].vaultTokenAccount = addresses.lookup; }],
    ['source decimals', (p) => { p.assets[0].sourceDecimals = 5; }],
  ])('refuses an independently drifted %s profile with the real projector', async (_label, mutate) => {
    const { extractor } = await fixture(['SPL']);
    const profile = createSolanaScanProfile(extractor.getResolvedProfile(), identity);
    mutate(profile);
    let storeAccesses = 0;
    const store = { withExclusiveScan: async (f) => f(), readState: async () => { storeAccesses++; }, initialize: async () => { storeAccesses++; }, installBatch: async () => { storeAccesses++; }, persistHold: async () => { storeAccesses++; } };
    expect(() => new SolanaFinalizedScanner({ rpc: {}, store, projector: extractor, profile })).toThrow('PROJECTOR_PROFILE_BINDING');
    expect(storeAccesses).toBe(0);
  });
});
