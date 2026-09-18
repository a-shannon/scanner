import { ExtractedObservation } from '@rosen-bridge/abstract-observation-extractor';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';

/** Raw, replayable input. This is not proof that the transaction is a deposit. */
export interface MoneroCandidateInput {
  txId: string;
  transactionHex: string;
}

export interface MoneroCandidate extends MoneroCandidateInput {
  id: number;
  sourceBlockId: string;
  sourceHeight: number;
  /** Digest of configured network, vault and verification policy. */
  scope: string;
}

export interface CandidateLease extends MoneroCandidate {
  token: string;
  revision: number;
  expiresAt: number;
}

/**
 * The verifier must reconstruct authority from current chain data on every call.
 * Missing, invalid or unavailable delivery evidence is retryable: a later proof
 * can be valid. Expiry is an independently verified policy decision, not a refund.
 */
export type AdmissionResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'accepted'; observation: ExtractedObservation };

export type AdmissionVerifier = (
  candidate: Readonly<MoneroCandidate>,
  signal: AbortSignal,
) => Promise<AdmissionResult>;

export interface CandidateStoreOptions {
  extractorId: string;
  scannerId: string;
  scope: string;
  /** Includes retained accepted/orphaned/expired records; exhaustion stops capture. */
  maxCandidates: number;
  maxTransactionBytes: number;
  leaseMs: number;
  retryMs: number;
  now?: () => number;
}

export type CandidateDecoder<Transaction> = (
  transaction: Transaction,
  block: Readonly<BlockInfo>,
) =>
  | MoneroCandidateInput
  | undefined
  | Promise<MoneroCandidateInput | undefined>;

export interface PendingRunResult {
  claimed: number;
  accepted: number;
  pending: number;
  expired: number;
  stale: number;
  failed: number;
}
