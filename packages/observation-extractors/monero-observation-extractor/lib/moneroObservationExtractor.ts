import { realpathSync } from 'node:fs';

import { AbstractExtractor } from '@rosen-bridge/abstract-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';

import { CandidateStore } from './actions/candidateStore';
import { MoneroCandidateEntity } from './entities/moneroCandidateEntity';
import {
  AdmissionResult,
  AdmissionVerifier,
  CandidateDecoder,
  CandidateLease,
  CandidateStoreOptions,
  PendingRunResult,
} from './types';

export interface VerificationOptions {
  verificationTimeoutMs?: number;
  maxConcurrentVerifications?: number;
}

/**
 * Captures candidates before scanner progress; proof admission runs separately.
 * Decoder and verifier are trusted composition dependencies, not caller claims.
 * Admission uses its own SQLite connection so upstream scanner transactions
 * cannot share its QueryRunner and accidentally commit half an admission.
 */
export class MoneroObservationExtractor<Transaction> extends AbstractExtractor<
  Transaction,
  MoneroCandidateEntity
> {
  private readonly store: CandidateStore;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly inFlight = new Set<Promise<AdmissionResult>>();
  private running = false;
  private closed = false;
  private readonly controllers = new Set<AbortController>();

  close = () => {
    this.closed = true;
    for (const controller of this.controllers)
      controller.abort(Error('Deposit extractor closed'));
  };

  constructor(
    scannerDataSource: DataSource,
    admissionDataSource: DataSource,
    options: CandidateStoreOptions,
    private readonly decode: CandidateDecoder<Transaction>,
    private readonly verify: AdmissionVerifier,
    verification: VerificationOptions = {},
  ) {
    super();
    if (scannerDataSource === admissionDataSource) {
      throw Error('Admission requires a separate SQLite connection');
    }
    for (const db of [scannerDataSource, admissionDataSource]) {
      if (
        !db.isInitialized ||
        db.options.type !== 'sqlite' ||
        db.options.database === ':memory:'
      ) {
        throw Error('Admission requires initialized disk SQLite connections');
      }
    }
    const scannerPath = realpathSync(
      String(scannerDataSource.options.database),
    );
    const admissionPath = realpathSync(
      String(admissionDataSource.options.database),
    );
    if (scannerPath !== admissionPath)
      throw Error('Connections must use the same SQLite database');
    this.timeoutMs =
      verification.verificationTimeoutMs ?? Math.floor(options.leaseMs / 2);
    this.concurrency = verification.maxConcurrentVerifications ?? 4;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs >= options.leaseMs ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw Error(
        'Verification timeout must be positive and shorter than the lease',
      );
    }
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      this.concurrency > 32
    ) {
      throw Error('Verification concurrency must be between 1 and 32');
    }
    this.store = new CandidateStore(admissionDataSource, options);
  }

  getId = () => this.store.options.extractorId;

  processTransactions = async (
    transactions: Transaction[],
    block: BlockInfo,
  ) => {
    if (this.closed) throw Error('Deposit extractor closed');
    const candidates = transactions.flatMap((transaction) => {
      const candidate = this.decode(transaction, block);
      return candidate ? [candidate] : [];
    });
    // Errors propagate to the scanner. No cursor success before durable capture.
    await this.store.capture(candidates, block);
    return true;
  };

  initializeData = async () => {};
  forkBlock = (hash: string) => this.store.forkBlock(hash);
  createUsedBlocksQuery = () => this.store.createUsedBlocksQuery();

  private verifyLease = async (
    lease: CandidateLease,
  ): Promise<AdmissionResult> => {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Do not expose the mutable lease or its completion token to the verifier.
    const candidate = Object.freeze({
      id: lease.id,
      scope: lease.scope,
      txId: lease.txId,
      transactionHex: lease.transactionHex,
      sourceBlockId: lease.sourceBlockId,
      sourceHeight: lease.sourceHeight,
    });
    const task = Promise.resolve().then(() =>
      this.verify(candidate, controller.signal),
    );
    this.inFlight.add(task);
    // A provider ignoring abort retains its slot until it settles. Repeated
    // timeouts therefore cannot create an unbounded set of background tasks.
    void task.then(
      () => this.inFlight.delete(task),
      () => this.inFlight.delete(task),
    );
    let onAbort: () => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => controller.abort(Error('Deposit verification timed out')),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([task, deadline]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      this.controllers.delete(controller);
    }
  };

  /** Invoke periodically alongside scanner updates; this method starts no timers. */
  processPending = async (limit: number): Promise<PendingRunResult> => {
    if (this.closed) throw Error('Deposit extractor closed');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw Error('Pending batch limit must be between 1 and 32');
    }
    if (this.running) throw Error('Pending batch is already running');
    const result: PendingRunResult = {
      claimed: 0,
      accepted: 0,
      pending: 0,
      expired: 0,
      stale: 0,
      failed: 0,
    };
    const capacity = Math.min(limit, this.concurrency - this.inFlight.size);
    if (capacity <= 0) return result;
    this.running = true;
    try {
      const leases = await this.store.claim(capacity);
      result.claimed = leases.length;
      await Promise.all(
        leases.map(async (lease) => {
          try {
            const admission = await this.verifyLease(lease);
            if (this.closed) throw Error('Deposit extractor closed');
            result[await this.store.complete(lease, admission)]++;
          } catch {
            result.failed++;
            // A bad delivery or provider failure cannot permanently reject an
            // on-chain candidate. If storage is unavailable, lease expiry retries.
            try {
              await this.store.complete(lease, { status: 'pending' });
            } catch {
              /* retain lease */
            }
          }
        }),
      );
      return result;
    } finally {
      this.running = false;
    }
  };
}
