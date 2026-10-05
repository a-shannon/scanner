import { describe, expect, it } from 'vitest';

import { SolanaRpcUnavailableError, SolanaStoreFault } from '../lib/errors';
import { bindSolanaScanProfile, SolanaScanProfile } from '../lib/profile';
import { HttpSolanaRpc } from '../lib/rpc/httpSolanaRpc';
import { SolanaFinalizedScanner } from '../lib/scanner/solanaFinalizedScanner';
import { SolanaFinalizedScannerBounds } from '../lib/scanner/solanaFinalizedScanner';
import { SolanaScanStorePort } from '../lib/store/storePort';
import {
  SolanaBlockProjector,
  SolanaFinalizedHead,
  SolanaHistorySource,
  SolanaRosenBlockExtractionOutcome,
  SolanaRosenExtractionOutcome,
  SolanaRpc,
  SolanaRpcBlock,
  SolanaScanState,
  SolanaScannedBlock,
  SolanaScanStateUpdate,
} from '../lib/types';

const genesisHash = '1'.repeat(32);
const anchorHash = '1'.repeat(32);
const anchorParentHash = `${'1'.repeat(31)}4`;
const block103Hash = `${'1'.repeat(31)}2`;
const block109Hash = `${'1'.repeat(31)}3`;
const signatureA = '1'.repeat(64);
const signatureB = `${'1'.repeat(63)}2`;

const profile: SolanaScanProfile = {
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
      destinationTokenId: 'a'.repeat(64),
      minAmount: '1',
      maxAmount: '1000000000000',
      networkFee: '1',
      bridgeFee: '1',
    },
  ],
  memoVersion: 1,
  projectorVersion: 'test-projector-v1',
  anchor: { slot: 100, blockHeight: 50, blockhash: anchorHash },
};

/** Builds a finalized RPC block fixture with consistent transaction fields. */
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
  blockTime: 1_700_000_000,
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
const block109 = makeBlock(109, 52, 103, block103Hash, block109Hash, [
  signatureB,
]);
const head: SolanaFinalizedHead = {
  slot: 109,
  blockHeight: 52,
  blockhash: block109Hash,
  commitment: 'finalized',
};

const deposit: SolanaRosenExtractionOutcome = {
  type: 'deposit',
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
    targetChainTokenId: 'a'.repeat(64),
    sourceTxId: signatureA,
    rawData: '{"memo":"bridge-request"}',
  },
};

/** In-memory store mock used to inspect scanner state changes per scenario. */
class MemoryStore implements SolanaScanStorePort {
  /** Returns the binding of the profile used by the in-memory store fixture. */
  getProfileBinding = (): string => bindSolanaScanProfile(profile);
  state: SolanaScanState | undefined;
  installed: SolanaScannedBlock[][] = [];

  /** Runs one fixture operation under the store port's exclusive-scan contract. */
  withExclusiveScan = async <T>(operation: () => Promise<T>): Promise<T> =>
    operation();

  /** Returns the fixture's current scan state without copying it. */
  readState = async (): Promise<SolanaScanState | undefined> => this.state;

  /** Initializes fixture state only when the supplied block matches the anchor. */
  initialize = async (block: SolanaRpcBlock): Promise<SolanaScanState> => {
    if (this.state)
      throw new SolanaStoreFault('ALREADY_INITIALIZED', 'conflict');
    if (
      block.slot !== profile.anchor.slot ||
      block.blockHeight !== profile.anchor.blockHeight ||
      block.blockhash !== profile.anchor.blockhash
    )
      throw new SolanaStoreFault('ANCHOR_MISMATCH', 'identity');
    this.state = {
      schemaVersion: 1,
      genesisHash: profile.genesisHash,
      scannerId: profile.scannerId,
      extractorId: profile.extractorId,
      configBinding: bindSolanaScanProfile(profile),
      anchor: { ...profile.anchor },
      cursor: { ...profile.anchor },
      scannedThroughSlot: profile.anchor.slot,
      revision: 0,
      holdCode: null,
    };
    return this.state;
  };

  /** Installs one revision-matched batch and advances the fixture cursor. */
  installBatch = async (
    expectedRevision: number,
    next: SolanaScanStateUpdate,
    blocks: SolanaScannedBlock[],
  ): Promise<SolanaScanState> => {
    if (!this.state || this.state.revision !== expectedRevision)
      throw new SolanaStoreFault('REVISION_CONFLICT', 'conflict');
    this.installed.push(blocks);
    this.state = {
      ...this.state,
      cursor: { ...next.cursor },
      scannedThroughSlot: next.scannedThroughSlot,
      revision: this.state.revision + 1,
    };
    return this.state;
  };

  /** Persists a hold code when the expected fixture revision still matches. */
  persistHold = async (
    expectedRevision: number,
    code: string,
  ): Promise<void> => {
    if (!this.state || this.state.revision !== expectedRevision)
      throw new SolanaStoreFault('REVISION_CONFLICT', 'conflict');
    this.state = {
      ...this.state,
      holdCode: code,
      revision: this.state.revision + 1,
    };
  };
}

/** Deterministic RPC mock backed by the block fixtures for this spec. */
class FixtureRpc implements SolanaRpc {
  /** Creates an RPC fixture backed by blocks and an optional page error. */
  constructor(
    private readonly blocks: Map<number, SolanaRpcBlock>,
    private readonly options: { pageError?: Error } = {},
  ) {}

  /** Returns the fixture cluster's configured genesis hash. */
  getGenesisHash = async (): Promise<string> => genesisHash;
  /** Returns the fixture's first available slot. */
  getFirstAvailableBlock = async (): Promise<number> => 0;
  /** Returns the fixed finalized head used by scanner scenarios. */
  getFinalizedHead = async (): Promise<SolanaFinalizedHead> => head;
  /** Enumerates fixture slots in the requested inclusive range. */
  getBlocks = async (start: number, end: number): Promise<number[]> => {
    if (this.options.pageError) throw this.options.pageError;
    return [...this.blocks.keys()]
      .filter((slot) => slot >= start && slot <= end)
      .sort((left, right) => left - right);
  };
  /** Returns a fixture block by slot, or null when it is absent. */
  getBlock = async (slot: number): Promise<SolanaRpcBlock | null> =>
    this.blocks.get(slot) ?? null;
}

/** Builds the scanner and in-memory ports used by this spec's scenarios. */
const makeRig = (
  options: {
    blocks?: SolanaRpcBlock[];
    pageError?: Error;
    outcome?: SolanaRosenExtractionOutcome;
    bounds?: SolanaFinalizedScannerBounds;
    projection?: () => unknown;
    historySource?: SolanaHistorySource;
  } = {},
) => {
  const blocks = new Map(
    (options.blocks ?? [anchorBlock, block103, block109]).map((block) => [
      block.slot,
      block,
    ]),
  );
  const store = new MemoryStore();
  const rpc = new FixtureRpc(blocks, { pageError: options.pageError });
  const projector: SolanaBlockProjector = {
    getResolvedProfile: () => structuredClone(profile),
    getBlockWithContext: (raw) => {
      if (options.projection)
        return options.projection() as SolanaRosenBlockExtractionOutcome;
      const parsed = JSON.parse(raw) as { slot: number };
      const block = blocks.get(parsed.slot);
      if (!block) return { type: 'unavailable', reason: 'TEST_BLOCK_MISSING' };
      return {
        type: 'block',
        transactions: block.transactions.map(
          (transaction, transactionIndex) => ({
            transactionIndex,
            signature: transaction.signature,
            outcome:
              options.outcome && parsed.slot === block103.slot
                ? options.outcome
                : parsed.slot === block103.slot
                  ? deposit
                  : { type: 'not-deposit', reason: 'NO_ROSEN_MEMO' },
          }),
        ),
      };
    },
  };
  const scanner = new SolanaFinalizedScanner({
    rpc,
    store,
    profile,
    projector,
    bounds: options.bounds,
    historySource: options.historySource,
  });
  return { scanner, store, rpc, projector };
};

describe('SolanaFinalizedScanner', () => {
  describe('constructor', () => {
    /**
     * @target SolanaFinalizedScanner.constructor rejects the store binding before reading or initializing an empty database
     * @dependencies
     * - SolanaScanStorePort.getProfileBinding and bindSolanaScanProfile
     * - MemoryStore and the cloned SolanaScanProfile fixture
     * @scenario
     * - bind the empty store to a profile with a different vault owner
     * - construct the scanner and inspect the store
     * @expected
     * - construction rejects STORE_PROFILE_BINDING without reading or initializing state
     */
    it('rejects the store binding before reading or initializing an empty database', () => {
      const { store, rpc, projector } = makeRig();
      const other = structuredClone(profile);
      other.vaultOwner = 'other';
      store.getProfileBinding = () => bindSolanaScanProfile(other);
      expect(
        () => new SolanaFinalizedScanner({ store, rpc, projector, profile }),
      ).toThrow('STORE_PROFILE_BINDING');
      expect(store.state).toBeUndefined();
      expect(store.installed).toEqual([]);
    });

    /**
     * @target SolanaFinalizedScanner.constructor refuses a separate %s policy before store/RPC work
     * @dependencies
     * - SolanaFinalizedScanner constructor and bindSolanaScanProfile
     * - makeRig, MemoryStore, and cloned SolanaScanProfile fixtures
     * @scenario
     * - mutate one listed projector or asset policy field
     * - construct the scanner with the altered profile and inspect the store
     * @expected
     * - every separately changed policy is rejected before the store is initialized
     */
    it.each([
      [
        'vault',
        (p: SolanaScanProfile) => {
          p.vaultOwner = 'other';
        },
      ],
      [
        'maximum',
        (p: SolanaScanProfile) => {
          p.assets[0].maxAmount = '2';
        },
      ],
      [
        'minimum',
        (p: SolanaScanProfile) => {
          p.assets[0].minAmount = '2';
        },
      ],
      [
        'program',
        (p: SolanaScanProfile) => {
          p.assets[0].programId = 'other';
        },
      ],
      [
        'decimals',
        (p: SolanaScanProfile) => {
          p.assets[0].destinationDecimals = 10;
        },
      ],
      [
        'target token',
        (p: SolanaScanProfile) => {
          p.assets[0].destinationTokenId = 'b'.repeat(64);
        },
      ],
      [
        'network fee',
        (p: SolanaScanProfile) => {
          p.assets[0].networkFee = '2';
        },
      ],
      [
        'bridge fee',
        (p: SolanaScanProfile) => {
          p.assets[0].bridgeFee = '2';
        },
      ],
      [
        'network',
        (p: SolanaScanProfile) => {
          p.destinationNetwork = 'testnet';
        },
      ],
      [
        'version',
        (p: SolanaScanProfile) => {
          p.projectorVersion = 'other';
        },
      ],
    ])(
      'refuses a separate %s policy before store/RPC work',
      (_label, mutate) => {
        const { store, rpc, projector } = makeRig();
        const altered = structuredClone(profile);
        mutate(altered);
        expect(
          () =>
            new SolanaFinalizedScanner({
              store,
              rpc,
              projector,
              profile: altered,
            }),
        ).toThrow('PROJECTOR_PROFILE_BINDING');
        expect(store.state).toBeUndefined();
      },
    );

    /**
     * @target SolanaFinalizedScanner.constructor copies scanner profile values instead of retaining caller mutations
     * @dependencies
     * - SolanaFinalizedScanner and the SolanaScanProfile input
     * - makeRig, MemoryStore, and FixtureRpc
     * @scenario
     * - construct the scanner from a caller-owned profile
     * - mutate its vault owner, asset limit, and anchor before updating
     * @expected
     * - scanning uses the captured profile and completes the fixture observation
     */
    it('copies scanner profile values instead of retaining caller mutations', async () => {
      const { store, rpc, projector } = makeRig();
      const external = structuredClone(profile);
      const scanner = new SolanaFinalizedScanner({
        store,
        rpc,
        projector,
        profile: external,
      });
      external.vaultOwner = 'other';
      external.assets[0].maxAmount = '2';
      external.anchor.slot = 999;
      await expect(scanner.update()).resolves.toMatchObject({
        newObservations: 1,
      });
    });

    /**
     * @target SolanaFinalizedScanner.constructor rejects out-of-range scanner configuration %s=%i
     * @dependencies
     * - SolanaFinalizedScannerBounds validation through makeRig
     * - out-of-range scanner configuration cases
     * @scenario
     * - supply each listed lower or upper bound outside its accepted range
     * - construct the scanner fixture
     * @expected
     * - every out-of-range configuration is rejected with INVALID_SOLANA_SCANNER_BOUNDS
     */
    it.each([
      ['slotWindow', 0],
      ['slotWindow', 4097],
      ['maxPages', 0],
      ['maxPages', 17],
      ['maxTransactionsPerBlock', 0],
      ['maxTransactionsPerBlock', 8193],
      ['maxTransactionsPerBatch', 0],
      ['maxTransactionsPerBatch', 262_145],
      ['maxObservationsPerBatch', 0],
      ['maxObservationsPerBatch', 65_537],
      ['maxBlockResponseBytes', 1023],
      ['maxBlockResponseBytes', 64 * 1024 * 1024 + 1],
      ['maxHistoryBytesPerBatch', 0],
      ['maxHistoryBytesPerBatch', 64 * 1024 * 1024 + 1],
    ] as const)(
      'rejects out-of-range scanner configuration %s=%i',
      (name, value) => {
        expect(() => makeRig({ bounds: { [name]: value } })).toThrow(
          'INVALID_SOLANA_SCANNER_BOUNDS',
        );
      },
    );
  });

  describe('update', () => {
    /**
     * @target SolanaFinalizedScanner.update keeps a %i-character projector reason within the durable hold bound
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore
     * - makeRig projector outcome fixture
     * @scenario
     * - provide projector reasons of 54, 55, and 64 characters
     * - update the scanner and inspect the rejection and persisted hold code
     * @expected
     * - bounded reasons are retained and oversized reasons map to PROJECTOR_UNKNOWN within 64 characters
     */
    it.each([54, 55, 64])(
      'keeps a %i-character projector reason within the durable hold bound',
      async (length) => {
        const reason = 'X'.repeat(length);
        const { scanner, store } = makeRig({
          outcome: { type: 'unavailable', reason },
        });
        const expected = `PROJECTOR_${length <= 54 ? reason : 'UNKNOWN'}`;
        await expect(scanner.update()).rejects.toMatchObject({
          code: expected,
        });
        expect(store.state?.holdCode).toBe(expected);
        expect(expected.length).toBeLessThanOrEqual(64);
      },
    );

    /**
     * @target SolanaFinalizedScanner.update rejects cumulative history overflow when each block fits separately
     * @dependencies
     * - SolanaHistorySource and MemoryStore
     * - makeRig and the serialized history fixture
     * @scenario
     * - set the batch limit to the byte size of one block's history
     * - return valid history for both blocks and update the scanner
     * @expected
     * - cumulative overflow persists HISTORY_BYTES_BOUND without installing a batch
     */
    it('rejects cumulative history overflow when each block fits separately', async () => {
      /** Serializes one history entry with the fields consumed by the scanner. */
      const payload = (slot: number, signature: string) =>
        JSON.stringify({
          clusterGenesisHash: genesisHash,
          slot,
          sourceTxId: signature,
        });
      const perBlock =
        Buffer.byteLength(payload(103, signatureA)) + signatureA.length;
      const { scanner, store } = makeRig({
        bounds: { maxHistoryBytesPerBatch: perBlock },
        historySource: {
          getBlockHistory: async (request) => ({
            genesisHash: request.genesisHash,
            slot: request.slot,
            blockhash: request.blockhash,
            entries: request.signatures.map((signature) => ({
              signature,
              serializedHistory: payload(request.slot, signature),
            })),
          }),
        },
      });
      await expect(scanner.update()).rejects.toMatchObject({
        code: 'HISTORY_BYTES_BOUND',
      });
      expect(store.installed).toEqual([]);
      expect(store.state).toMatchObject({
        cursor: profile.anchor,
        holdCode: 'HISTORY_BYTES_BOUND',
      });
    });

    /**
     * @target SolanaFinalizedScanner.update rechecks the effective projector identity before resuming a scan
     * @dependencies
     * - SolanaBlockProjector and SolanaFinalizedScanner.update
     * - makeRig and the cloned SolanaScanProfile fixture
     * @scenario
     * - change the projector's resolved vault owner after constructing the scanner
     * - resume the scan and inspect the store
     * @expected
     * - the changed projector identity is rejected before scan state is created
     */
    it('rechecks the effective projector identity before resuming a scan', async () => {
      const { store, rpc, projector } = makeRig();
      const descriptor = structuredClone(profile);
      projector.getResolvedProfile = () => descriptor;
      const scanner = new SolanaFinalizedScanner({
        store,
        rpc,
        projector,
        profile,
      });
      descriptor.vaultOwner = 'other';
      await expect(scanner.update()).rejects.toMatchObject({
        code: 'PROJECTOR_PROFILE_BINDING',
      });
      expect(store.state).toBeUndefined();
    });

    /**
     * @target SolanaFinalizedScanner.update joins HTTP error %s to durable hold %s without advancing
     * @dependencies
     * - HttpSolanaRpc, SolanaFinalizedScanner, and MemoryStore
     * - makeRig profile/projector fixtures and the injected HTTP fetcher
     * @scenario
     * - return each listed RPC error or a missing finalized block
     * - run the scan and inspect the hold, cursor, and installed blocks
     * @expected
     * - the mapped hold is persisted when required, the cursor stays at the anchor, and no block is installed
     */
    it.each([
      [-32001, 'HISTORY_GAP'],
      [-32007, 'HISTORY_GAP'],
      [-32009, 'HISTORY_GAP'],
      [-32011, 'HISTORY_GAP'],
      [-32021, 'HISTORY_GAP'],
      [-32015, 'BLOCK_VERSION_UNSUPPORTED'],
      [-32005, null],
      [-32014, null],
      [-32016, null],
      [-32019, null],
      [-32099, null],
      [null, 'HISTORY_GAP'],
    ])(
      'joins HTTP error %s to durable hold %s without advancing',
      async (rpcCode, holdCode) => {
        const { store, projector } = makeRig();
        let requestedFinalizedBlock = false;
        const rpc = new HttpSolanaRpc({
          endpoint: 'https://fixture.invalid',
          fetcher: async (_input, init) => {
            const q = JSON.parse(String(init?.body)) as {
              id: string;
              method: string;
              params: unknown[];
            };
            const envelope: Record<string, unknown> = {
              jsonrpc: '2.0',
              id: q.id,
            };
            if (q.method === 'getGenesisHash') envelope.result = genesisHash;
            else if (q.method === 'getFirstAvailableBlock') envelope.result = 0;
            else if (q.method === 'getSlot') envelope.result = 109;
            else if (q.method === 'getBlock' && q.params[0] === 100)
              envelope.result = { ...anchorBlock, transactions: [] };
            else if (q.method === 'getBlock' && q.params[0] === 109) {
              requestedFinalizedBlock = true;
              if (rpcCode === null) envelope.result = null;
              else envelope.error = { code: rpcCode, message: 'fixture' };
            } else throw new Error('Unexpected RPC request');
            return new Response(JSON.stringify(envelope));
          },
        });
        const scanner = new SolanaFinalizedScanner({
          rpc,
          store,
          profile,
          projector,
        });
        await expect(scanner.update()).rejects.toMatchObject({
          code: holdCode ?? 'RPC_METHOD_ERROR',
          rpcMethod: 'getBlock',
          ...(rpcCode !== null ? { rpcCode } : {}),
        });
        expect(requestedFinalizedBlock).toBe(true);
        expect(store.state).toMatchObject({
          holdCode,
          revision: holdCode ? 1 : 0,
          cursor: profile.anchor,
          scannedThroughSlot: 100,
        });
        expect(store.installed).toEqual([]);
      },
    );

    /**
     * @target SolanaFinalizedScanner.update retries an unavailable finalized head block and advances when it appears
     * @dependencies
     * - HttpSolanaRpc, SolanaFinalizedScanner, and MemoryStore
     * - makeRig block fixtures and the injected HTTP fetcher
     * @scenario
     * - make the first finalized-head block request unavailable
     * - verify no progress, then retry after the block becomes available
     * @expected
     * - the first attempt leaves state unchanged and the retry catches up with one installed observation
     */
    it('retries an unavailable finalized head block and advances when it appears', async () => {
      const { store, projector } = makeRig();
      const blocks = new Map([
        [100, anchorBlock],
        [103, block103],
        [109, block109],
      ]);
      let finalizedBlockReads = 0;
      const rpc = new HttpSolanaRpc({
        endpoint: 'https://fixture.invalid',
        fetcher: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as {
            id: string;
            method: string;
            params: unknown[];
          };
          const envelope: Record<string, unknown> = {
            jsonrpc: '2.0',
            id: request.id,
          };
          if (request.method === 'getGenesisHash') {
            envelope.result = genesisHash;
          } else if (request.method === 'getFirstAvailableBlock') {
            envelope.result = 0;
          } else if (request.method === 'getSlot') {
            envelope.result = head.slot;
          } else if (request.method === 'getBlocks') {
            envelope.result = [103, 109];
          } else if (request.method === 'getBlock') {
            const slot = request.params[0] as number;
            if (slot === 109 && finalizedBlockReads++ === 0) {
              envelope.error = {
                code: -32004,
                message: 'block not available yet',
              };
            } else {
              const block = blocks.get(slot);
              if (!block) throw new Error(`Unexpected block slot: ${slot}`);
              envelope.result = {
                slot: block.slot,
                blockHeight: block.blockHeight,
                blockhash: block.blockhash,
                parentSlot: block.parentSlot,
                previousBlockhash: block.previousBlockhash,
                blockTime: block.blockTime,
                transactions: block.transactions.map(({ signature }) => ({
                  transaction: { signatures: [signature] },
                })),
              };
            }
          } else {
            throw new Error(`Unexpected RPC method: ${request.method}`);
          }
          return new Response(JSON.stringify(envelope));
        },
      });
      projector.getBlockWithContext = (raw) => {
        const body = JSON.parse(raw) as {
          result: {
            transactions: Array<{ transaction: { signatures: string[] } }>;
          };
        };
        return {
          type: 'block',
          transactions: body.result.transactions.map((transaction, index) => {
            const signature = transaction.transaction.signatures[0];
            return {
              transactionIndex: index,
              signature,
              outcome:
                signature === signatureA
                  ? deposit
                  : { type: 'not-deposit', reason: 'NO_ROSEN_MEMO' },
            };
          }),
        };
      };
      const scanner = new SolanaFinalizedScanner({
        rpc,
        store,
        profile,
        projector,
      });

      await expect(scanner.update()).rejects.toMatchObject({
        name: 'SolanaRpcUnavailableError',
        code: 'RPC_METHOD_ERROR',
        rpcMethod: 'getBlock',
        rpcCode: -32004,
      });
      expect(store.state).toMatchObject({
        holdCode: null,
        revision: 0,
        cursor: profile.anchor,
        scannedThroughSlot: profile.anchor.slot,
      });
      expect(store.installed).toEqual([]);

      await expect(scanner.update()).resolves.toMatchObject({
        status: 'caught-up',
        cursor: {
          slot: head.slot,
          blockHeight: head.blockHeight,
          blockhash: head.blockhash,
        },
        scannedThroughSlot: head.slot,
        newObservations: 1,
      });
      expect(finalizedBlockReads).toBe(3);
      expect(store.state).toMatchObject({
        holdCode: null,
        revision: 1,
        cursor: {
          slot: head.slot,
          blockHeight: head.blockHeight,
          blockhash: head.blockhash,
        },
        scannedThroughSlot: head.slot,
      });
      expect(store.installed).toHaveLength(1);
    });

    /**
     * @target SolanaFinalizedScanner.update persists a controlled hold for %s projector output
     * @dependencies
     * - SolanaBlockProjector, SolanaFinalizedScanner, and MemoryStore
     * - makeRig and malformed projector-output fixtures
     * @scenario
     * - supply each missing, null, unknown, or incomplete projector result
     * - update the scanner and inspect persisted state
     * @expected
     * - each invalid projector result persists PROJECTOR_SCHEMA and installs no block
     */
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['unknown tag', { type: 'unknown', transactions: [] }],
      ['missing transactions', { type: 'block' }],
      [
        'missing outcome',
        {
          type: 'block',
          transactions: [{ transactionIndex: 0, signature: signatureA }],
        },
      ],
      [
        'unknown outcome',
        {
          type: 'block',
          transactions: [
            {
              transactionIndex: 0,
              signature: signatureA,
              outcome: { type: 'unknown' },
            },
          ],
        },
      ],
    ])(
      'persists a controlled hold for %s projector output',
      async (_label, value) => {
        const { scanner, store } = makeRig({ projection: () => value });
        await expect(scanner.update()).rejects.toMatchObject({
          code: 'PROJECTOR_SCHEMA',
        });
        expect(store.state).toMatchObject({
          holdCode: 'PROJECTOR_SCHEMA',
          cursor: profile.anchor,
        });
        expect(store.installed).toEqual([]);
      },
    );

    /**
     * @target SolanaFinalizedScanner.update does not report a persisted hold when its write fails
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore.persistHold
     * - makeRig and SolanaStoreFault
     * @scenario
     * - inject a store failure when persisting a projector hold
     * - update the scanner and inspect state and installed blocks
     * @expected
     * - STORE_FAILURE is returned without reporting a saved hold or installing a block
     */
    it('does not report a persisted hold when its write fails', async () => {
      const { scanner, store } = makeRig({ projection: () => undefined });
      store.persistHold = async () => {
        throw new SolanaStoreFault('STORE_FAILURE', 'unavailable');
      };
      await expect(scanner.update()).rejects.toMatchObject({
        code: 'STORE_FAILURE',
      });
      expect(store.state).toMatchObject({ holdCode: null, revision: 0 });
      expect(store.installed).toEqual([]);
    });

    /**
     * @target SolanaFinalizedScanner.update bounds cumulative historical payload before projection or batch installation
     * @dependencies
     * - SolanaHistorySource, SolanaFinalizedScanner.update, and MemoryStore
     * - makeRig and the serialized history fixture
     * @scenario
     * - configure a one-byte history limit and return a nonempty history entry
     * - update the scanner and inspect its durable state
     * @expected
     * - HISTORY_BYTES_BOUND is persisted before any block is installed
     */
    it('bounds cumulative historical payload before projection or batch installation', async () => {
      const { scanner, store } = makeRig({
        bounds: { maxHistoryBytesPerBatch: 1 },
        historySource: {
          getBlockHistory: async (request) => ({
            genesisHash: request.genesisHash,
            slot: request.slot,
            blockhash: request.blockhash,
            entries: [
              { signature: request.signatures[0], serializedHistory: '{}' },
            ],
          }),
        },
      });
      await expect(scanner.update()).rejects.toMatchObject({
        code: 'HISTORY_BYTES_BOUND',
      });
      expect(store.state).toMatchObject({
        holdCode: 'HISTORY_BYTES_BOUND',
        cursor: profile.anchor,
      });
      expect(store.installed).toEqual([]);
    });

    /**
     * @target SolanaFinalizedScanner.update walks sparse finalized slots and stores the produced blockHeight cursor
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore.installBatch
     * - makeRig, FixtureRpc, and finalized block fixtures
     * @scenario
     * - enumerate finalized slots 103 and 109 after anchor slot 100
     * - update the scanner and inspect its cursor and installed observations
     * @expected
     * - the scanner catches up over sparse slots and persists the produced block height and blocks
     */
    it('walks sparse finalized slots and stores the produced blockHeight cursor', async () => {
      const { scanner, store } = makeRig();

      const result = await scanner.update();

      expect(result).toMatchObject({
        status: 'caught-up',
        pages: 1,
        blocks: 2,
        newObservations: 1,
        cursor: { slot: 109, blockHeight: 52, blockhash: block109Hash },
        scannedThroughSlot: 109,
        revision: 1,
      });
      expect(store.installed[0]).toHaveLength(2);
      expect(store.installed[0][0].block).toMatchObject({
        slot: 103,
        blockHeight: 51,
      });
      expect('rawResponse' in store.installed[0][0].block).toBe(false);
      expect(store.installed[0][0].deposits).toEqual([
        expect.objectContaining({ signature: signatureA }),
      ]);
      expect(store.installed[0][1].deposits).toEqual([]);
    });

    /**
     * @target SolanaFinalizedScanner.update persists a hold when produced-block parent linkage is inconsistent
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore
     * - makeBlock, makeRig, and finalized block fixtures
     * @scenario
     * - replace a candidate block with one whose parent slot skips its predecessor
     * - update the scanner and inspect persisted state
     * @expected
     * - PARENT_SLOT is persisted and the inconsistent batch is not installed
     */
    it('persists a hold when produced-block parent linkage is inconsistent', async () => {
      const badBlock = makeBlock(103, 51, 101, anchorHash, block103Hash, [
        signatureA,
      ]);
      const { scanner, store } = makeRig({
        blocks: [anchorBlock, badBlock, block109],
      });

      await expect(scanner.update()).rejects.toMatchObject({
        name: 'SolanaScannerFault',
        code: 'PARENT_SLOT',
      });
      expect(store.state).toMatchObject({
        holdCode: 'PARENT_SLOT',
        revision: 1,
      });
      expect(store.installed).toHaveLength(0);
    });

    /**
     * @target SolanaFinalizedScanner.update persists a hold for an unavailable candidate and makes no partial install
     * @dependencies
     * - SolanaBlockProjector, SolanaFinalizedScanner.update, and MemoryStore
     * - makeRig and the unavailable projector outcome fixture
     * @scenario
     * - return an unavailable SPL-history outcome for a candidate block
     * - update the scanner and inspect state and installed blocks
     * @expected
     * - PROJECTOR_SPL_HISTORY is persisted and no candidate block is installed
     */
    it('persists a hold for an unavailable candidate and makes no partial install', async () => {
      const { scanner, store } = makeRig({
        outcome: { type: 'unavailable', reason: 'SPL_HISTORY' },
      });

      await expect(scanner.update()).rejects.toMatchObject({
        name: 'SolanaScannerFault',
        code: 'PROJECTOR_SPL_HISTORY',
      });
      expect(store.state).toMatchObject({
        holdCode: 'PROJECTOR_SPL_HISTORY',
        revision: 1,
        cursor: profile.anchor,
      });
      expect(store.installed).toHaveLength(0);
    });

    /**
     * @target SolanaFinalizedScanner.update leaves the state unchanged on a transient RPC failure
     * @dependencies
     * - SolanaRpc and SolanaFinalizedScanner.update
     * - makeRig, FixtureRpc, and SolanaRpcUnavailableError
     * @scenario
     * - make finalized-slot enumeration fail transiently
     * - update the scanner and inspect cursor, hold, and installed blocks
     * @expected
     * - RPC_TIMEOUT propagates without advancing the cursor or persisting a hold
     */
    it('leaves the state unchanged on a transient RPC failure', async () => {
      const { scanner, store } = makeRig({
        pageError: new SolanaRpcUnavailableError('RPC_TIMEOUT'),
      });

      await expect(scanner.update()).rejects.toMatchObject({
        name: 'SolanaRpcUnavailableError',
        code: 'RPC_TIMEOUT',
      });
      expect(store.state).toMatchObject({
        revision: 0,
        holdCode: null,
        cursor: profile.anchor,
        scannedThroughSlot: profile.anchor.slot,
      });
      expect(store.installed).toHaveLength(0);
    });

    /**
     * @target SolanaFinalizedScanner.update converts malformed projector output into a durable fail-closed hold
     * @dependencies
     * - SolanaBlockProjector, SolanaFinalizedScanner.update, and MemoryStore
     * - makeRig and the malformed deposit outcome fixture
     * @scenario
     * - return a deposit whose destination address is null
     * - update the scanner and inspect the persisted hold
     * @expected
     * - PROJECTOR_BINDING is persisted and the malformed deposit is not installed
     */
    it('converts malformed projector output into a durable fail-closed hold', async () => {
      const malformed = {
        type: 'deposit',
        context: deposit.type === 'deposit' ? deposit.context : {},
        data: {
          ...(deposit.type === 'deposit' ? deposit.data : {}),
          toAddress: null,
        },
      } as unknown as SolanaRosenExtractionOutcome;
      const { scanner, store } = makeRig({ outcome: malformed });

      await expect(scanner.update()).rejects.toMatchObject({
        name: 'SolanaScannerFault',
        code: 'PROJECTOR_BINDING',
      });
      expect(store.state).toMatchObject({ holdCode: 'PROJECTOR_BINDING' });
      expect(store.installed).toHaveLength(0);
    });

    /**
     * @target SolanaFinalizedScanner.update fails closed before installing a batch over its cumulative transaction bound
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore
     * - makeRig and SolanaFinalizedScannerBounds
     * @scenario
     * - set the batch transaction maximum below the fixture's transaction count
     * - update the scanner and inspect state and installed blocks
     * @expected
     * - TRANSACTION_BATCH_BOUND is persisted and the oversized batch is not installed
     */
    it('fails closed before installing a batch over its cumulative transaction bound', async () => {
      const { scanner, store } = makeRig({
        bounds: { maxTransactionsPerBatch: 1 },
      });

      await expect(scanner.update()).rejects.toMatchObject({
        name: 'SolanaScannerFault',
        code: 'TRANSACTION_BATCH_BOUND',
      });
      expect(store.state).toMatchObject({
        holdCode: 'TRANSACTION_BATCH_BOUND',
        revision: 1,
        cursor: profile.anchor,
      });
      expect(store.installed).toHaveLength(0);
    });

    /**
     * @target SolanaFinalizedScanner.update accepts exact per-block, batch, observation, response, page, and history limits
     * @dependencies
     * - SolanaFinalizedScanner.update, SolanaHistorySource, and MemoryStore
     * - makeRig and bounded finalized-block/history fixtures
     * @scenario
     * - construct response and history payloads exactly at each configured maximum
     * - update the scanner and inspect the resulting cursor and state
     * @expected
     * - values at every configured limit are accepted and the scanner catches up without a hold
     */
    it('accepts exact per-block, batch, observation, response, page, and history limits', async () => {
      const maxBytes = 1024;
      /** Pads a block fixture's serialized response to the configured byte limit. */
      const fitResponse = (block: SolanaRpcBlock): SolanaRpcBlock => {
        const json = JSON.stringify({
          slot: block.slot,
          blockhash: block.blockhash,
        });
        return {
          ...block,
          rawResponse: json + ' '.repeat(maxBytes - json.length),
        };
      };
      const boundedBlocks = [
        anchorBlock,
        fitResponse(block103),
        fitResponse(block109),
      ];
      const historyEntries = [
        { slot: block103.slot, signature: signatureA },
        { slot: block109.slot, signature: signatureB },
      ].map(({ slot, signature }) => ({
        signature,
        serializedHistory: JSON.stringify({
          clusterGenesisHash: genesisHash,
          slot,
          sourceTxId: signature,
        }),
      }));
      const exactHistoryBytes = historyEntries.reduce(
        (sum, entry) =>
          sum + Buffer.byteLength(entry.signature + entry.serializedHistory),
        0,
      );
      const { scanner, store } = makeRig({
        blocks: boundedBlocks,
        bounds: {
          slotWindow: 6,
          maxPages: 2,
          maxTransactionsPerBlock: 1,
          maxTransactionsPerBatch: 2,
          maxObservationsPerBatch: 1,
          maxBlockResponseBytes: maxBytes,
          maxHistoryBytesPerBatch: exactHistoryBytes,
        },
        historySource: {
          getBlockHistory: async (request) => ({
            genesisHash: request.genesisHash,
            slot: request.slot,
            blockhash: request.blockhash,
            entries: historyEntries.filter(({ signature }) =>
              request.signatures.includes(signature),
            ),
          }),
        },
      });
      await expect(scanner.update()).resolves.toMatchObject({
        status: 'caught-up',
        pages: 2,
        blocks: 2,
        newObservations: 1,
      });
      expect(store.state).toMatchObject({
        cursor: { slot: 109, blockHeight: 52, blockhash: block109Hash },
        scannedThroughSlot: 109,
        revision: 1,
        holdCode: null,
      });
    });

    /**
     * @target SolanaFinalizedScanner.update rejects a collection exceeding its configured limit: %s
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore
     * - makeBlock, makeRig, and per-block/batch bound fixtures
     * @scenario
     * - exceed the configured per-block count, response-byte, or batch transaction limit
     * - update the scanner and inspect state and installed blocks
     * @expected
     * - each over-limit collection is rejected with its expected code and installs no batch
     */
    it.each([
      [
        'per-block transaction count',
        (blocks: SolanaRpcBlock[]): void => {
          blocks[1] = makeBlock(103, 51, 100, anchorHash, block103Hash, [
            signatureA,
            signatureB,
          ]);
        },
        { maxTransactionsPerBlock: 1 },
        'BLOCK_SCHEMA',
      ],
      [
        'response bytes',
        (blocks: SolanaRpcBlock[]): void => {
          blocks[1] = { ...blocks[1], rawResponse: 'x'.repeat(1025) };
        },
        { maxBlockResponseBytes: 1024 },
        'BLOCK_SCHEMA',
      ],
      [
        'cumulative transaction count',
        (): void => {},
        { maxTransactionsPerBatch: 1 },
        'TRANSACTION_BATCH_BOUND',
      ],
    ] as const)(
      'rejects a collection exceeding its configured limit: %s',
      async (_label, mutate, bounds, code) => {
        const blocks = [anchorBlock, block103, block109];
        mutate(blocks);
        const { scanner, store } = makeRig({ blocks, bounds });
        await expect(scanner.update()).rejects.toMatchObject({ code });
        expect(store.installed).toEqual([]);
        expect(store.state?.cursor).toEqual(profile.anchor);
      },
    );

    /**
     * @target SolanaFinalizedScanner.update rejects the observation count just above its configured maximum
     * @dependencies
     * - SolanaBlockProjector, SolanaFinalizedScanner.update, and MemoryStore
     * - makeBlock, makeRig, and two-deposit projector fixture
     * @scenario
     * - project two deposits with the observation maximum set to one
     * - update the scanner and inspect state and installed blocks
     * @expected
     * - EVENT_BOUND is persisted and neither observation is installed
     */
    it('rejects the observation count just above its configured maximum', async () => {
      const twoDepositBlock = makeBlock(
        103,
        51,
        100,
        anchorHash,
        block103Hash,
        [signatureA, signatureB],
      );
      /** Builds the two-deposit projector result used by the event-bound case. */
      const projection = () => ({
        type: 'block',
        transactions: [signatureA, signatureB].map(
          (signature, transactionIndex) => ({
            transactionIndex,
            signature,
            outcome: {
              type: 'deposit',
              context: {
                clusterGenesisHash: genesisHash,
                sourceTxId: signature,
                sourceSlot: twoDepositBlock.slot,
                sourceBlockhash: twoDepositBlock.blockhash,
              },
              data: {
                ...(deposit.type === 'deposit' ? deposit.data : {}),
                sourceTxId: signature,
              },
            },
          }),
        ),
      });
      const { scanner, store } = makeRig({
        blocks: [anchorBlock, twoDepositBlock, block109],
        bounds: { maxObservationsPerBatch: 1 },
        projection,
      });
      await expect(scanner.update()).rejects.toMatchObject({
        code: 'EVENT_BOUND',
      });
      expect(store.installed).toEqual([]);
      expect(store.state).toMatchObject({
        holdCode: 'EVENT_BOUND',
        cursor: profile.anchor,
      });
    });

    /**
     * @target SolanaFinalizedScanner.update holds on invalid integer field: %s
     * @dependencies
     * - SolanaFinalizedScanner.update and MemoryStore
     * - makeRig, finalized block fixtures, and invalid integer-field cases
     * @scenario
     * - supply a candidate with an unsafe parent slot, oversized block height, or null timestamp
     * - update the scanner and inspect state and installed blocks
     * @expected
     * - each invalid candidate persists BLOCK_SCHEMA without installing a block
     */
    it.each([
      [
        'parent slot above safe integer',
        { ...block103, parentSlot: Number.MAX_SAFE_INTEGER + 1 },
      ],
      [
        'block height above Rosen bound',
        { ...block103, blockHeight: 2_147_483_648 },
      ],
      ['null block timestamp', { ...block103, blockTime: null }],
    ] as const)(
      'holds on invalid integer field: %s',
      async (_label, badBlock) => {
        const { scanner, store } = makeRig({
          blocks: [anchorBlock, badBlock as SolanaRpcBlock, block109],
        });
        await expect(scanner.update()).rejects.toMatchObject({
          code: 'BLOCK_SCHEMA',
        });
        expect(store.state).toMatchObject({
          revision: 1,
          holdCode: 'BLOCK_SCHEMA',
          cursor: profile.anchor,
        });
        expect(store.installed).toEqual([]);
      },
    );

    /**
     * @target SolanaFinalizedScanner.update rejects an unsafe slot returned by block enumeration
     * @dependencies
     * - SolanaRpc.getBlocks, SolanaFinalizedScanner.update, and MemoryStore
     * - makeRig and the unsafe slot fixture
     * @scenario
     * - make the RPC return a slot above Number.MAX_SAFE_INTEGER
     * - update the scanner and inspect the persisted range hold
     * @expected
     * - PAGE_RANGE is persisted and the cursor and installed blocks remain unchanged
     */
    it('rejects an unsafe slot returned by block enumeration', async () => {
      const { scanner, store, rpc } = makeRig();
      rpc.getBlocks = async () => [Number.MAX_SAFE_INTEGER + 1];
      await expect(scanner.update()).rejects.toMatchObject({
        code: 'PAGE_RANGE',
      });
      expect(store.state).toMatchObject({
        revision: 1,
        holdCode: 'PAGE_RANGE',
        cursor: profile.anchor,
      });
      expect(store.installed).toEqual([]);
    });
  });
});
