import { SolanaScannerFault, SolanaStoreFault } from '../errors';
import {
  bindSolanaScanProfile,
  createSolanaScanProfile,
  SolanaScanProfile,
} from '../profile';
import { SolanaScanStorePort } from '../store/storePort';
import {
  SolanaBlockProjector,
  SolanaDepositCandidate,
  SolanaDepositContext,
  SolanaFinalizedHead,
  SolanaHistorySource,
  SolanaRpc,
  SolanaRpcBlock,
  SolanaRosenData,
  SolanaScanRef,
  SolanaScanResult,
  SolanaScanState,
  SolanaScannedBlock,
  SolanaScanStateUpdate,
} from '../types';
import { prepareSolanaHistory } from './prepareHistory';

const MAX_SLOT_WINDOW = 4096;
const MAX_PAGES = 16;
const MAX_TRANSACTIONS = 8192;
const MAX_BATCH_TRANSACTIONS = 262_144;
const MAX_OBSERVATIONS = 65_536;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ROSEN_HEIGHT = 2_147_483_647;
const FINALIZED_BLOCK_CONFIG = {
  commitment: 'finalized',
  maxSupportedTransactionVersion: 0,
} as const;

export interface SolanaFinalizedScannerBounds {
  slotWindow?: number;
  maxPages?: number;
  maxTransactionsPerBlock?: number;
  maxTransactionsPerBatch?: number;
  maxObservationsPerBatch?: number;
  maxBlockResponseBytes?: number;
  maxHistoryBytesPerBatch?: number;
}

export interface SolanaFinalizedScannerConfig {
  rpc: SolanaRpc;
  store: SolanaScanStorePort;
  profile: SolanaScanProfile;
  projector: SolanaBlockProjector;
  historySource?: SolanaHistorySource;
  bounds?: SolanaFinalizedScannerBounds;
}

/** Return a non-negative safe integer within the supplied maximum. */
const requireUint = (
  value: unknown,
  code: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    throw new SolanaScannerFault(code);
  return value as number;
};

/** Require non-empty text no longer than 128 characters. */
const requireText = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128)
    throw new SolanaScannerFault(code);
  return value;
};

/** Select the slot, block height, and hash fields used as a scan reference. */
const refOf = (block: SolanaRpcBlock): SolanaScanRef => ({
  slot: block.slot,
  blockHeight: block.blockHeight,
  blockhash: block.blockhash,
});

/** Compare scan references by slot, block height, and block hash. */
const sameRef = (left: SolanaScanRef, right: SolanaScanRef): boolean =>
  left.slot === right.slot &&
  left.blockHeight === right.blockHeight &&
  left.blockhash === right.blockhash;

/** Validate the numeric and textual fields of a scan reference. */
const validateRef = (value: SolanaScanRef): void => {
  requireUint(value.slot, 'REF_SCHEMA');
  requireUint(value.blockHeight, 'REF_SCHEMA', MAX_ROSEN_HEIGHT);
  requireText(value.blockhash, 'REF_SCHEMA');
};

/** Validate a fetched block's requested slot, fields, size, and transactions. */
const validateBlock = (
  block: SolanaRpcBlock | null,
  requestedSlot: number,
  bounds: Required<SolanaFinalizedScannerBounds>,
): SolanaRpcBlock => {
  if (block === null) throw new SolanaScannerFault('HISTORY_GAP');
  requireUint(block.slot, 'BLOCK_SCHEMA');
  requireUint(block.blockHeight, 'BLOCK_SCHEMA', MAX_ROSEN_HEIGHT);
  requireUint(block.parentSlot, 'BLOCK_SCHEMA');
  requireUint(block.blockTime, 'BLOCK_SCHEMA', MAX_ROSEN_HEIGHT);
  requireText(block.blockhash, 'BLOCK_SCHEMA');
  requireText(block.previousBlockhash, 'BLOCK_SCHEMA');
  if (
    block.slot !== requestedSlot ||
    block.commitment !== 'finalized' ||
    block.parentSlot >= block.slot ||
    !Array.isArray(block.transactions) ||
    block.transactions.length > bounds.maxTransactionsPerBlock ||
    typeof block.rawResponse !== 'string' ||
    Buffer.byteLength(block.rawResponse, 'utf8') > bounds.maxBlockResponseBytes
  )
    throw new SolanaScannerFault('BLOCK_SCHEMA');
  const signatures = new Set<string>();
  for (const [index, transaction] of block.transactions.entries()) {
    const signature = requireText(transaction.signature, 'TX_SCHEMA');
    requireUint(transaction.transactionIndex, 'TX_SCHEMA');
    if (transaction.transactionIndex !== index || signatures.has(signature))
      throw new SolanaScannerFault('DUPLICATE_TRANSACTION');
    signatures.add(signature);
  }
  return block;
};

/** Validate a finalized-head reference and its commitment label. */
const validateHead = (head: SolanaFinalizedHead): void => {
  validateRef(head);
  if (head.commitment !== 'finalized')
    throw new SolanaScannerFault('HEAD_FINALITY');
};

/** Bound projector reason text to the store format, using UNKNOWN otherwise. */
const canonicalReason = (value: unknown): string => {
  // Leave room for PROJECTOR_ inside the store's 64-character hold bound.
  if (typeof value === 'string' && /^[A-Z0-9_-]{1,54}$/.test(value))
    return value;
  return 'UNKNOWN';
};

/** Check for an unsigned decimal amount string of at most 39 digits. */
const canonicalAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);

/** Check that text is non-empty and no longer than the supplied limit. */
const boundedText = (value: unknown, maximum = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

/** Narrow a non-null, non-array object to a string-keyed record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate projector context and deposit data against the source block. */
const validateDeposit = (
  signature: string,
  context: unknown,
  data: unknown,
  block: SolanaRpcBlock,
  genesisHash: string,
): SolanaDepositCandidate => {
  if (!isRecord(context) || !isRecord(data))
    throw new SolanaScannerFault('PROJECTOR_BINDING');
  if (
    context.clusterGenesisHash !== genesisHash ||
    context.sourceTxId !== signature ||
    context.sourceSlot !== block.slot ||
    context.sourceBlockhash !== block.blockhash ||
    data.sourceTxId !== signature ||
    !canonicalAmount(data.amount) ||
    !canonicalAmount(data.bridgeFee) ||
    !canonicalAmount(data.networkFee) ||
    !boundedText(data.toChain, 128) ||
    !boundedText(data.toAddress) ||
    !boundedText(data.fromAddress) ||
    !boundedText(data.sourceChainTokenId, 128) ||
    !boundedText(data.targetChainTokenId, 128) ||
    !boundedText(data.rawData, 2048)
  )
    throw new SolanaScannerFault('PROJECTOR_BINDING');
  return {
    signature,
    context: context as unknown as SolanaDepositContext,
    data: data as unknown as SolanaRosenData,
  };
};

/** Check persisted scanner identity, cursor bounds, revision, and hold format. */
const validateIdentity = (
  state: SolanaScanState,
  profile: SolanaScanProfile,
  configBinding: string,
): void => {
  if (
    state.schemaVersion !== 1 ||
    state.genesisHash !== profile.genesisHash ||
    state.scannerId !== profile.scannerId ||
    state.extractorId !== profile.extractorId ||
    state.configBinding !== configBinding ||
    !sameRef(state.anchor, profile.anchor)
  )
    throw new SolanaScannerFault('CONFIG_IDENTITY');
  validateRef(state.cursor);
  requireUint(state.scannedThroughSlot, 'STATE_SCHEMA');
  requireUint(state.revision, 'STATE_SCHEMA');
  if (
    state.cursor.slot < state.anchor.slot ||
    state.cursor.blockHeight < state.anchor.blockHeight ||
    state.scannedThroughSlot < state.cursor.slot ||
    (state.holdCode !== null && !/^[A-Z0-9_-]{1,64}$/.test(state.holdCode))
  )
    throw new SolanaScannerFault('STATE_SCHEMA');
};

/** Owns the sparse-slot lifecycle and delegates every durable write to the store. */
export class SolanaFinalizedScanner {
  private readonly bounds: Required<SolanaFinalizedScannerBounds>;
  private readonly configBinding: string;
  private readonly config: SolanaFinalizedScannerConfig;

  /** Snapshot configuration, apply bounds, and verify profile bindings. */
  constructor(config: SolanaFinalizedScannerConfig) {
    this.config = {
      ...config,
      profile: structuredClone(config.profile),
      projector: {
        getResolvedProfile: config.projector.getResolvedProfile.bind(
          config.projector,
        ),
        getBlockWithContext: config.projector.getBlockWithContext.bind(
          config.projector,
        ),
      },
    };
    this.bounds = {
      slotWindow: config.bounds?.slotWindow ?? 64,
      maxPages: config.bounds?.maxPages ?? 4,
      maxTransactionsPerBlock: config.bounds?.maxTransactionsPerBlock ?? 4096,
      maxTransactionsPerBatch: config.bounds?.maxTransactionsPerBatch ?? 65_536,
      maxObservationsPerBatch: config.bounds?.maxObservationsPerBatch ?? 4096,
      maxBlockResponseBytes:
        config.bounds?.maxBlockResponseBytes ?? 32 * 1024 * 1024,
      maxHistoryBytesPerBatch:
        config.bounds?.maxHistoryBytesPerBatch ?? 32 * 1024 * 1024,
    };
    if (
      !Number.isSafeInteger(this.bounds.slotWindow) ||
      this.bounds.slotWindow < 1 ||
      this.bounds.slotWindow > MAX_SLOT_WINDOW ||
      !Number.isSafeInteger(this.bounds.maxPages) ||
      this.bounds.maxPages < 1 ||
      this.bounds.maxPages > MAX_PAGES ||
      !Number.isSafeInteger(this.bounds.maxTransactionsPerBlock) ||
      this.bounds.maxTransactionsPerBlock < 1 ||
      this.bounds.maxTransactionsPerBlock > MAX_TRANSACTIONS ||
      !Number.isSafeInteger(this.bounds.maxTransactionsPerBatch) ||
      this.bounds.maxTransactionsPerBatch < 1 ||
      this.bounds.maxTransactionsPerBatch > MAX_BATCH_TRANSACTIONS ||
      !Number.isSafeInteger(this.bounds.maxObservationsPerBatch) ||
      this.bounds.maxObservationsPerBatch < 1 ||
      this.bounds.maxObservationsPerBatch > MAX_OBSERVATIONS ||
      !Number.isSafeInteger(this.bounds.maxBlockResponseBytes) ||
      this.bounds.maxBlockResponseBytes < 1024 ||
      this.bounds.maxBlockResponseBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(this.bounds.maxHistoryBytesPerBatch) ||
      this.bounds.maxHistoryBytesPerBatch < 1 ||
      this.bounds.maxHistoryBytesPerBatch > MAX_RESPONSE_BYTES
    )
      throw new Error('INVALID_SOLANA_SCANNER_BOUNDS');
    this.configBinding = bindSolanaScanProfile(this.config.profile);
    this.assertProjectorBinding();
    this.assertStoreBinding();
  }

  /** Ensure the store is bound to this scanner's profile digest. */
  private assertStoreBinding = (): void => {
    if (this.config.store.getProfileBinding() !== this.configBinding)
      throw new SolanaScannerFault('STORE_PROFILE_BINDING');
  };

  /** Ensure the projector's resolved profile matches this scanner profile. */
  private assertProjectorBinding = (): void => {
    try {
      const actual = createSolanaScanProfile(
        this.config.projector.getResolvedProfile(),
        this.config.profile,
      );
      if (bindSolanaScanProfile(actual) !== this.configBinding)
        throw new Error('PROJECTOR_PROFILE_BINDING');
    } catch {
      throw new SolanaScannerFault('PROJECTOR_PROFILE_BINDING');
    }
  };

  /** Run one scan update within the store's exclusive-scan operation. */
  update = (): Promise<SolanaScanResult> =>
    this.config.store.withExclusiveScan(() => this.updateExclusive());

  /** Fetch and validate scan history, then submit a bounded store batch. */
  private updateExclusive = async (): Promise<SolanaScanResult> => {
    this.assertProjectorBinding();
    this.assertStoreBinding();
    let state = await this.config.store.readState();
    if (!state) state = await this.initializeProfile();
    validateIdentity(state, this.config.profile, this.configBinding);
    if (state.holdCode) throw new SolanaScannerFault(`HELD_${state.holdCode}`);

    try {
      const revision = state.revision;
      const knownGenesis = await this.config.rpc.getGenesisHash();
      if (knownGenesis !== this.config.profile.genesisHash)
        throw new SolanaScannerFault('GENESIS_MISMATCH');
      const firstAvailable = await this.config.rpc.getFirstAvailableBlock();
      requireUint(firstAvailable, 'RETENTION_SCHEMA');
      if (firstAvailable > state.cursor.slot)
        throw new SolanaScannerFault('HISTORY_GAP');

      const saved = validateBlock(
        await this.config.rpc.getBlock(
          state.cursor.slot,
          FINALIZED_BLOCK_CONFIG,
        ),
        state.cursor.slot,
        this.bounds,
      );
      if (!sameRef(refOf(saved), state.cursor))
        throw new SolanaScannerFault('CURSOR_MISMATCH');

      const head = await this.config.rpc.getFinalizedHead();
      validateHead(head);
      if (
        head.slot < state.scannedThroughSlot ||
        head.blockHeight < state.cursor.blockHeight
      )
        throw new SolanaScannerFault('HEAD_REGRESSION');
      if (head.slot === state.cursor.slot && !sameRef(head, state.cursor))
        throw new SolanaScannerFault('ROOT_MISMATCH');

      let pages = 0;
      let blocks = 0;
      let cursor = { ...state.cursor };
      let scannedThroughSlot = state.scannedThroughSlot;
      const scannedBlocks: SolanaScannedBlock[] = [];
      let transactionCount = 0;
      let observationCount = 0;
      let historyBytes = 0;

      while (scannedThroughSlot < head.slot && pages < this.bounds.maxPages) {
        const start = scannedThroughSlot + 1;
        const end =
          start + Math.min(this.bounds.slotWindow - 1, head.slot - start);
        const slots = await this.config.rpc.getBlocks(start, end, {
          commitment: 'finalized',
        });
        if (!Array.isArray(slots) || slots.length > this.bounds.slotWindow)
          throw new SolanaScannerFault('PAGE_BOUND');
        let previous = start - 1;
        for (const slotValue of slots) {
          const slot = requireUint(slotValue, 'PAGE_RANGE');
          if (slot < start || slot > end || slot <= previous)
            throw new SolanaScannerFault('PAGE_ORDER');
          previous = slot;
          const block = validateBlock(
            await this.config.rpc.getBlock(slot, FINALIZED_BLOCK_CONFIG),
            slot,
            this.bounds,
          );
          transactionCount += block.transactions.length;
          if (transactionCount > this.bounds.maxTransactionsPerBatch)
            throw new SolanaScannerFault('TRANSACTION_BATCH_BOUND');
          if (block.parentSlot !== cursor.slot)
            throw new SolanaScannerFault('PARENT_SLOT');
          if (block.previousBlockhash !== cursor.blockhash)
            throw new SolanaScannerFault('PARENT_HASH');
          if (block.blockHeight !== cursor.blockHeight + 1)
            throw new SolanaScannerFault('BLOCK_HEIGHT');

          const prepared = await prepareSolanaHistory(
            this.config.historySource,
            {
              ...refOf(block),
              genesisHash: this.config.profile.genesisHash,
              signatures: block.transactions.map(({ signature }) => signature),
            },
            this.bounds.maxHistoryBytesPerBatch - historyBytes,
          );
          historyBytes += prepared.bytes;
          const projected: unknown = this.config.projector.getBlockWithContext(
            block.rawResponse,
            { slot: block.slot, blockhash: block.blockhash },
            prepared.history,
          );
          if (!isRecord(projected))
            throw new SolanaScannerFault('PROJECTOR_SCHEMA');
          if (projected.type === 'unavailable')
            throw new SolanaScannerFault(
              `PROJECTOR_${canonicalReason(projected.reason)}`,
            );
          if (
            projected.type !== 'block' ||
            !Array.isArray(projected.transactions)
          )
            throw new SolanaScannerFault('PROJECTOR_SCHEMA');
          if (projected.transactions.length !== block.transactions.length)
            throw new SolanaScannerFault('PROJECTOR_TRANSACTION_BINDING');
          const deposits: SolanaScannedBlock['deposits'] = [];
          for (const [index, transaction] of block.transactions.entries()) {
            const result = projected.transactions[index];
            if (
              !isRecord(result) ||
              result.transactionIndex !== index ||
              result.signature !== transaction.signature
            )
              throw new SolanaScannerFault('PROJECTOR_TRANSACTION_BINDING');
            if (
              !isRecord(result.outcome) ||
              !['deposit', 'not-deposit', 'unavailable'].includes(
                result.outcome.type as string,
              )
            )
              throw new SolanaScannerFault('PROJECTOR_SCHEMA');
            if (result.outcome.type === 'unavailable')
              throw new SolanaScannerFault(
                `PROJECTOR_${canonicalReason(result.outcome.reason)}`,
              );
            if (result.outcome.type === 'not-deposit') {
              if (!boundedText(result.outcome.reason, 128))
                throw new SolanaScannerFault('PROJECTOR_SCHEMA');
              continue;
            }
            const candidate = validateDeposit(
              transaction.signature,
              result.outcome.context,
              result.outcome.data,
              block,
              this.config.profile.genesisHash,
            );
            if (observationCount >= this.bounds.maxObservationsPerBatch)
              throw new SolanaScannerFault('EVENT_BOUND');
            observationCount++;
            deposits.push(candidate);
          }
          // Do not retain full RPC JSON bodies in the staged database batch.
          const storedBlock: SolanaScannedBlock['block'] = {
            slot: block.slot,
            blockHeight: block.blockHeight,
            blockhash: block.blockhash,
            parentSlot: block.parentSlot,
            previousBlockhash: block.previousBlockhash,
            blockTime: block.blockTime,
            commitment: block.commitment,
            transactions: block.transactions,
          };
          scannedBlocks.push({ block: storedBlock, deposits });
          cursor = refOf(block);
          blocks++;
        }
        scannedThroughSlot = end;
        pages++;
        if (end === head.slot && !sameRef(cursor, head))
          throw new SolanaScannerFault('ROOT_MISMATCH');
      }

      if (
        (await this.config.rpc.getGenesisHash()) !==
        this.config.profile.genesisHash
      )
        throw new SolanaScannerFault('GENESIS_MISMATCH');
      this.assertProjectorBinding();
      if (pages === 0) {
        return {
          status: 'caught-up',
          pages,
          blocks,
          newObservations: 0,
          revision,
          cursor: state.cursor,
          scannedThroughSlot: state.scannedThroughSlot,
        };
      }
      const next: SolanaScanStateUpdate = { cursor, scannedThroughSlot };
      const committed = await this.config.store.installBatch(
        revision,
        next,
        scannedBlocks,
      );
      return {
        status:
          committed.scannedThroughSlot === head.slot ? 'caught-up' : 'yielded',
        pages,
        blocks,
        newObservations: observationCount,
        revision: committed.revision,
        cursor: committed.cursor,
        scannedThroughSlot: committed.scannedThroughSlot,
      };
    } catch (error) {
      const contentCode =
        error instanceof SolanaScannerFault
          ? error.code
          : error instanceof SolanaStoreFault && error.kind === 'content'
            ? error.code
            : undefined;
      if (contentCode) {
        await this.config.store.persistHold(state.revision, contentCode);
        throw error instanceof SolanaScannerFault
          ? error
          : new SolanaScannerFault(contentCode);
      }
      throw error;
    }
  };

  /** Verify the configured anchor against RPC data and initialize store state. */
  private initializeProfile = async (): Promise<SolanaScanState> => {
    const { profile, rpc, store } = this.config;
    if ((await rpc.getGenesisHash()) !== profile.genesisHash)
      throw new SolanaScannerFault('GENESIS_MISMATCH');
    const firstAvailable = await rpc.getFirstAvailableBlock();
    requireUint(firstAvailable, 'RETENTION_SCHEMA');
    if (firstAvailable > profile.anchor.slot)
      throw new SolanaScannerFault('HISTORY_GAP');
    const anchorBlock = validateBlock(
      await rpc.getBlock(profile.anchor.slot, FINALIZED_BLOCK_CONFIG),
      profile.anchor.slot,
      this.bounds,
    );
    if (!sameRef(refOf(anchorBlock), profile.anchor))
      throw new SolanaScannerFault('ANCHOR_MISMATCH');
    if ((await rpc.getGenesisHash()) !== profile.genesisHash)
      throw new SolanaScannerFault('GENESIS_MISMATCH');
    return store.initialize(anchorBlock);
  };
}
