import { TransactionResponse } from 'ethers';

import { ScannerConfig } from '@rosen-bridge/abstract-scanner';
import { Block } from '@rosen-bridge/scanner-interfaces';
import { Mutex } from '@rosen-bridge/semaphore';

import {
  AvalancheRpcNetwork,
  AvalancheRpcValidationError,
} from './avalancheRpcNetwork';
import { AvalancheSafetyState } from './avalancheSafetyState';
import { EvmRpcScanner } from './evmRpcScanner';

export type AvalancheScannerConfig = Omit<
  ScannerConfig<TransactionResponse>,
  'network'
> & {
  network: AvalancheRpcNetwork;
  /** Stable operator-assigned provider identity; never a URL or credential. */
  sourceId: string;
};

const POLICY = 'helicon-settled-v1';

/** Settled C-Chain scanner. A contradiction requires operator investigation. */
export class AvalancheRpcScanner extends EvmRpcScanner {
  private updating = false;
  private consuming = false;
  private readonly healthReadMutex = new Mutex();
  private healthReadPending = 0;
  private healthReadActive = false;

  /** Binds the scanner to its settled connector and durable source identity. */
  constructor(private readonly config: AvalancheScannerConfig) {
    if (!(config.network instanceof AvalancheRpcNetwork))
      throw new Error('Avalanche scanner requires its settled RPC connector');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.sourceId))
      throw new Error('Invalid Avalanche RPC source identity');
    if (
      !Number.isSafeInteger(config.initialHeight) ||
      config.initialHeight < -1
    )
      throw new Error('Invalid Avalanche initial height');
    if (config.heightGap !== undefined && config.heightGap !== 1)
      throw new Error('Avalanche scanner requires contiguous blocks');
    if (config.suffix)
      throw new Error('Avalanche scanner requires a stable database identity');
    super('avalanche', config);
  }

  /** Compares persisted and observed hashes independently of letter case. */
  private sameHash(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
  }

  /** Downstream signing and submission must check this persisted stop state. */
  assertUsable = async (): Promise<void> => {
    if (this.updating)
      throw new Error('Avalanche scanner update is still running');
    const state = await this.config.dataSource
      .getRepository(AvalancheSafetyState)
      .findOneBy({ scanner: this.name() });
    if (
      !state ||
      state.holdReason ||
      state.finalizedHeight === null ||
      !Number.isSafeInteger(state.finalizedHeight) ||
      state.finalizedHeight < 0 ||
      state.finalizedHash === null ||
      !/^0x[0-9a-fA-F]{64}$/.test(state.finalizedHash) ||
      state.chainId !== this.config.network.expectedChainId.toString() ||
      state.sourceId !== this.config.sourceId ||
      state.policy !== POLICY ||
      state.initialHeight !== this.config.initialHeight
    )
      throw new Error(
        'Avalanche scanner is not qualified for downstream processing',
      );
  };

  /** Binds an observation consumer to a completed block in this scanner. */
  assertObservation = async (height: number, hash: string): Promise<void> => {
    await this.assertUsable();
    if (
      !Number.isSafeInteger(height) ||
      height < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(hash)
    )
      throw new Error('Invalid Avalanche observation block identity');
    const stored = await this.action.getBlockAtHeight(height);
    if (!stored || !this.sameHash(stored.hash, hash))
      throw new Error('Avalanche observation has no matching completed block');
  };

  /** Binds an action to a completed observation under the safety exclusion. */
  withObservation = async <T>(
    height: number,
    hash: string,
    action: () => T | Promise<T>,
  ): Promise<T> =>
    this.withSafety(async () => {
      await this.assertObservation(height, hash);
      return await action();
    });

  /** Excludes updates while a qualified action runs on this scanner instance. */
  withSafety = async <T>(action: () => T | Promise<T>): Promise<T> => {
    if (this.updating || this.consuming)
      throw new Error('Avalanche scanner operation already running');
    this.consuming = true;
    try {
      await this.assertUsable();
      return await action();
    } finally {
      this.consuming = false;
    }
  };

  /**
   * Serializes bounded health reads without changing exclusive action admission.
   * @param action Qualified read whose result must remain current until completion.
   * @param timeoutMs Absolute wait-and-read budget in milliseconds.
   * @param maxPending Maximum outstanding health calls, including an active call.
   * @returns The read result before its deadline; timeout never releases an active lease.
   */
  withHealthRead = async <T>(
    action: () => T | Promise<T>,
    timeoutMs: number,
    maxPending: number,
  ): Promise<T> => {
    if (
      typeof action !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2147483647 ||
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1
    )
      throw new Error('Invalid Avalanche health read bounds');
    if (this.updating || (this.consuming && !this.healthReadActive))
      throw new Error('Avalanche scanner operation already running');
    if (this.healthReadPending >= maxPending)
      throw new Error('Avalanche health read queue is full');
    this.healthReadPending++;
    const deadline = performance.now() + timeoutMs;
    let expired = false;
    const failure = new Error('Avalanche health read deadline exceeded');
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(failure);
      }, timeoutMs);
    });
    const work = this.healthReadMutex.acquire().then(async (release) => {
      try {
        if (expired || performance.now() >= deadline) throw failure;
        this.healthReadActive = true;
        return await this.withSafety(async () => {
          const value = await action();
          if (expired || performance.now() >= deadline) throw failure;
          return value;
        });
      } finally {
        this.healthReadActive = false;
        this.healthReadPending--;
        clearTimeout(timer);
        release();
      }
    });
    return Promise.race([work, timeout]);
  };

  /** Advances one persisted frontier or records a hold on conflicting history. */
  update = async (): Promise<void> => {
    if (this.updating || this.consuming)
      throw new Error('Avalanche scanner operation already running');
    this.updating = true;
    let state: AvalancheSafetyState | null = null;
    try {
      const repository =
        this.config.dataSource.getRepository(AvalancheSafetyState);
      state = await repository.findOneBy({ scanner: this.name() });
      if (!state) {
        const existingBlocks = await this.action.blockRepository.countBy({
          scanner: this.name(),
        });
        state = await repository.save(
          repository.create({
            scanner: this.name(),
            chainId: this.config.network.expectedChainId.toString(),
            sourceId: this.config.sourceId,
            policy: POLICY,
            initialHeight: this.config.initialHeight,
            finalizedHeight: null,
            finalizedHash: null,
            holdReason: existingBlocks ? 'unqualified-existing-history' : null,
          }),
        );
      }
      if (state.holdReason)
        throw new Error(`Avalanche scanner held: ${state.holdReason}`);
      if (
        state.chainId !== this.config.network.expectedChainId.toString() ||
        state.sourceId !== this.config.sourceId ||
        state.initialHeight !== this.config.initialHeight ||
        state.policy !== POLICY
      )
        throw new AvalancheRpcValidationError('scanner-identity-changed');
      if (
        (state.finalizedHeight === null) !== (state.finalizedHash === null) ||
        (state.finalizedHeight !== null &&
          (!Number.isSafeInteger(state.finalizedHeight) ||
            state.finalizedHeight < 0)) ||
        (state.finalizedHash !== null &&
          !/^0x[0-9a-fA-F]{64}$/.test(state.finalizedHash))
      )
        throw new AvalancheRpcValidationError('invalid-persisted-frontier');

      const network = this.config.network;
      const seen = new Map<number, Block>();
      /** Rejects inconsistent block responses seen during this update. */
      const getBlock = async (height: number): Promise<Block> => {
        const block = await network.getBlockAtHeight(height);
        const earlier = seen.get(height);
        if (
          earlier &&
          (!this.sameHash(earlier.hash, block.hash) ||
            !this.sameHash(earlier.parentHash, block.parentHash) ||
            earlier.timestamp !== block.timestamp ||
            earlier.txCount !== block.txCount)
        )
          throw new AvalancheRpcValidationError('settled-response-conflict');
        seen.set(height, block);
        return block;
      };
      const frontier = await network.getCurrentHeight();
      if (state.finalizedHeight !== null) {
        if (frontier < state.finalizedHeight)
          throw new AvalancheRpcValidationError('settled-frontier-regressed');
        const previous = await getBlock(state.finalizedHeight);
        if (!this.sameHash(previous.hash, state.finalizedHash!))
          throw new AvalancheRpcValidationError('settled-frontier-conflict');
      }
      const current = await getBlock(frontier);
      const [persistedTip] = await this.action.blockRepository.find({
        where: { scanner: this.name() },
        order: { height: 'DESC' },
        take: 1,
      });
      if (persistedTip && persistedTip.height > frontier)
        throw new AvalancheRpcValidationError('persisted-tip-above-frontier');
      let last = await this.action.getLastSavedBlock();
      if (last) {
        if (last.height > frontier)
          throw new AvalancheRpcValidationError('processed-tip-above-frontier');
        const canonical = await getBlock(last.height);
        if (
          !this.sameHash(canonical.hash, last.hash) ||
          !this.sameHash(canonical.parentHash, last.parentHash)
        )
          throw new AvalancheRpcValidationError('processed-tip-conflict');
      }
      state.finalizedHeight = frontier;
      state.finalizedHash = current.hash;
      await repository.save(state);
      this.blockChainLastHeight = frontier;

      if (last) await this.verifyExtractorsInitialization(last);
      for (
        let height = last ? last.height + 1 : this.config.initialHeight + 1;
        height <= frontier;
        height++
      ) {
        const block = await getBlock(height);
        const persisted = await this.action.blockRepository.findOneBy({
          scanner: this.name(),
          height,
        });
        if (
          persisted &&
          (!this.sameHash(persisted.hash, block.hash) ||
            !this.sameHash(persisted.parentHash, block.parentHash) ||
            persisted.timestamp !== block.timestamp)
        )
          throw new AvalancheRpcValidationError('persisted-block-conflict');
        if (last && !this.sameHash(block.parentHash, last.hash))
          throw new AvalancheRpcValidationError('settled-parent-conflict');
        if (!last)
          await this.verifyExtractorsInitialization({
            height: height - 1,
            hash: block.parentHash,
          });
        const saved = await this.processBlock(block);
        if (typeof saved === 'boolean')
          throw new Error('Avalanche block extraction incomplete');
        last = saved;
      }
      if (last) await this.removeOldUnusedBlocks(last);
    } catch (error) {
      if (state && error instanceof AvalancheRpcValidationError) {
        state.holdReason = 'settled-rpc-or-history-conflict';
        await this.config.dataSource
          .getRepository(AvalancheSafetyState)
          .save(state);
      }
      throw error;
    } finally {
      this.updating = false;
    }
  };
}
