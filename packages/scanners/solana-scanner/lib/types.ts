import type { SolanaProjectorProfile } from './profile';

export interface SolanaBlockRef {
  slot: number;
  blockHeight: number;
  blockhash: string;
}

export interface SolanaRpcTransaction {
  signature: string;
  transactionIndex: number;
}

export interface SolanaRpcBlock extends SolanaBlockRef {
  parentSlot: number;
  previousBlockhash: string;
  blockTime: number;
  commitment: 'finalized';
  transactions: SolanaRpcTransaction[];
  rawResponse: string;
}

export interface SolanaFinalizedHead extends SolanaBlockRef {
  commitment: 'finalized';
}

export interface SolanaRpc {
  getGenesisHash(): Promise<string>;
  getFirstAvailableBlock(): Promise<number>;
  getFinalizedHead(): Promise<SolanaFinalizedHead>;
  getBlocks(
    start: number,
    end: number,
    config: { commitment: 'finalized' },
  ): Promise<number[]>;
  getBlock(
    slot: number,
    config: {
      commitment: 'finalized';
      maxSupportedTransactionVersion: 0;
    },
  ): Promise<SolanaRpcBlock | null>;
}

export interface SolanaBlockProjectionContext {
  slot: number;
  blockhash: string;
}

export interface SolanaRosenData {
  toChain: string;
  toAddress: string;
  bridgeFee: string;
  networkFee: string;
  fromAddress: string;
  sourceChainTokenId: string;
  amount: string;
  targetChainTokenId: string;
  sourceTxId: string;
  rawData: string;
}

export interface SolanaDepositContext {
  clusterGenesisHash: string;
  sourceTxId: string;
  sourceSlot: number;
  sourceBlockhash: string;
}

export type SolanaRosenExtractionOutcome =
  | {
      type: 'deposit';
      data: SolanaRosenData;
      context: SolanaDepositContext;
    }
  | { type: 'not-deposit'; reason: string }
  | { type: 'unavailable'; reason: string };

export interface SolanaRosenBlockExtraction {
  type: 'block';
  transactions: Array<{
    transactionIndex: number;
    signature: string;
    outcome: SolanaRosenExtractionOutcome;
  }>;
}

export type SolanaRosenBlockExtractionOutcome =
  | SolanaRosenBlockExtraction
  | { type: 'unavailable'; reason: string };

export interface SolanaBlockProjector {
  getResolvedProfile(): SolanaProjectorProfile;
  getBlockWithContext(
    serializedBlockResponse: string,
    context: SolanaBlockProjectionContext,
    historyBySignature?: ReadonlyMap<string, unknown>,
  ): SolanaRosenBlockExtractionOutcome;
}

export interface SolanaBlockHistoryRequest extends SolanaBlockRef {
  genesisHash: string;
  signatures: readonly string[];
}

export interface SolanaBlockHistory {
  genesisHash: string;
  slot: number;
  blockhash: string;
  entries: readonly { signature: string; serializedHistory: string }[];
}

/** Acquisition happens before projection and outside the SQL transaction. */
export interface SolanaHistorySource {
  getBlockHistory(
    request: SolanaBlockHistoryRequest,
    limits: { maxEntries: number; maxBytes: number },
  ): Promise<SolanaBlockHistory>;
}

export interface SolanaDepositCandidate {
  signature: string;
  data: SolanaRosenData;
  context: SolanaDepositContext;
}

export interface SolanaScannedBlock {
  block: Omit<SolanaRpcBlock, 'rawResponse'>;
  deposits: SolanaDepositCandidate[];
}

export interface SolanaScanRef {
  slot: number;
  blockHeight: number;
  blockhash: string;
}

export interface SolanaScanState {
  schemaVersion: 1;
  genesisHash: string;
  scannerId: string;
  extractorId: string;
  configBinding: string;
  anchor: SolanaScanRef;
  cursor: SolanaScanRef;
  scannedThroughSlot: number;
  revision: number;
  holdCode: string | null;
}

export interface SolanaScanStateUpdate {
  cursor: SolanaScanRef;
  scannedThroughSlot: number;
}

export interface SolanaScanResult {
  status: 'caught-up' | 'yielded';
  pages: number;
  blocks: number;
  newObservations: number;
  revision: number;
  cursor: SolanaScanRef;
  scannedThroughSlot: number;
}
