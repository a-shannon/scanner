import {
  Block as EthersBlock,
  makeError,
  Transaction,
  TransactionReceipt,
  TransactionResponse,
} from 'ethers';

import { Block } from '@rosen-bridge/scanner-interfaces';

import { EvmRpcNetwork } from './evmRpcNetwork';
import { BlockNotFound } from './types';

type IdentifiedBlock = EthersBlock & { hash: string };
type BlockIdentity = Readonly<
  Pick<
    IdentifiedBlock,
    'number' | 'hash' | 'parentHash' | 'timestamp' | 'length'
  > & {
    transactions: readonly string[];
  }
>;

export class AvalancheRpcValidationError extends Error {}

/** Carries the receipt admitted by this connector into observation extraction. */
class SettledTransactionResponse extends TransactionResponse {
  readonly #receipt: TransactionReceipt;

  /** Copies the admitted receipt so later provider mutation cannot replace it. */
  constructor(transaction: TransactionResponse, receipt: TransactionReceipt) {
    super(transaction, transaction.provider);
    this.#receipt = new TransactionReceipt(receipt, transaction.provider);
    Object.freeze(this.#receipt);
  }

  /** Returns the admitted receipt for wait(0), with SDK-compatible revert errors. */
  wait = async (confirms?: number): Promise<TransactionReceipt> => {
    if (confirms !== 0)
      throw new Error('Settled Avalanche transactions support only wait(0)');
    if (this.#receipt.status === 0)
      throw makeError('transaction execution reverted', 'CALL_EXCEPTION', {
        action: 'sendTransaction',
        data: null,
        reason: null,
        invocation: null,
        revert: null,
        transaction: {
          to: this.#receipt.to,
          from: this.#receipt.from,
          data: '',
        },
        receipt: this.#receipt,
      });
    return this.#receipt;
  };
}

/**
 * C-Chain settlement reads for AvalancheGo v1.15.0 (Helicon).
 * The finalized tag tracks settled execution; latest tracks execution only.
 * Receipts can exist before their block has finished executing.
 */
export class AvalancheRpcNetwork extends EvmRpcNetwork {
  /** Requires an explicit C-Chain identity and validates any supplied timeout. */
  constructor(
    url: string,
    readonly expectedChainId: bigint,
    timeout?: number,
    authToken?: string,
  ) {
    if (
      timeout !== undefined &&
      (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
    ) {
      throw new AvalancheRpcValidationError('Invalid Avalanche RPC timeout');
    }
    super(url, timeout, authToken);
    if (expectedChainId !== 43113n && expectedChainId !== 43114n) {
      throw new AvalancheRpcValidationError(
        'Avalanche C-Chain ID must be 43113 or 43114',
      );
    }
    // ethers formats receipt logs without their raw removed flag. Preserve it
    // through its receipt extension point so extraction can reject removed or
    // unspecified movement using the same admitted RPC response.
    const wrapReceipt = this.provider._wrapTransactionReceipt;
    this.provider._wrapTransactionReceipt = (value, network) => {
      const removed = value.logs.map((log) => log.removed);
      const receipt = wrapReceipt.call(this.provider, value, network);
      return new TransactionReceipt(
        {
          ...receipt,
          logs: receipt.logs.map((log, index) => ({
            ...log,
            removed: removed[index],
          })),
        },
        this.provider,
      );
    };
  }

  /** Checks the endpoint's current chain identity through a fresh RPC request. */
  private assertChainId = async (): Promise<void> => {
    const chainId: unknown = await this.provider.send('eth_chainId', []);
    if (
      typeof chainId !== 'string' ||
      !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(chainId) ||
      BigInt(chainId) !== this.expectedChainId
    ) {
      throw new AvalancheRpcValidationError(
        'Invalid or unexpected Avalanche C-Chain ID',
      );
    }
  };

  /** Requires an exactly representable nonnegative numeric field. */
  private assertNumber(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AvalancheRpcValidationError(`Invalid Avalanche ${field}`);
    }
  }

  /** Requires a complete 32-byte hexadecimal hash for the named field. */
  private assertHash(
    value: string | null,
    field: string,
  ): asserts value is string {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new AvalancheRpcValidationError(`Invalid Avalanche ${field}`);
    }
  }

  /** Compares hash identities independently of hexadecimal letter case. */
  private sameHash(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
  }

  /** Validates block identity and its complete, unique transaction-hash list. */
  private assertBlock(
    block: EthersBlock | null,
  ): asserts block is IdentifiedBlock {
    if (block == null) {
      throw new BlockNotFound('Avalanche block is unavailable');
    }
    this.assertNumber(block.number, 'block number');
    this.assertNumber(block.timestamp, 'block timestamp');
    this.assertNumber(block.length, 'transaction count');
    this.assertHash(block.hash, 'block hash');
    this.assertHash(block.parentHash, 'parent hash');
    if (/^0x0{64}$/i.test(block.hash)) {
      throw new AvalancheRpcValidationError(
        'Invalid Avalanche zero block hash',
      );
    }
    if (
      !Array.isArray(block.transactions) ||
      block.transactions.length !== block.length
    ) {
      throw new AvalancheRpcValidationError(
        'Invalid Avalanche transaction count',
      );
    }
    const hashes = new Set<string>();
    for (const hash of block.transactions) {
      this.assertHash(hash, 'transaction hash');
      if (hashes.has(hash.toLowerCase())) {
        throw new AvalancheRpcValidationError(
          'Duplicate Avalanche transaction hash',
        );
      }
      hashes.add(hash.toLowerCase());
    }
  }

  /** Detaches and freezes validated block identity before asynchronous work. */
  private captureBlock(block: EthersBlock | null): BlockIdentity {
    this.assertBlock(block);
    return Object.freeze({
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      length: block.length,
      transactions: Object.freeze([...block.transactions]),
    });
  }

  /** Copies signed transaction fields and nested arrays from the provider object. */
  private captureTransaction(tx: TransactionResponse): TransactionResponse {
    try {
      // Parsing detaches signature/access-list/authorization arrays from the
      // provider object, whose primitive fields are also copied before any wait.
      const signed = Transaction.from(tx);
      if (signed.hash === null || !this.sameHash(signed.hash, tx.hash))
        throw new Error('Unsigned or mismatched transaction');
      return new TransactionResponse(
        {
          ...tx,
          signature: signed.signature!,
          accessList: signed.accessList,
          blobVersionedHashes: signed.blobVersionedHashes,
          authorizationList: signed.authorizationList,
        },
        tx.provider,
      );
    } catch {
      throw new AvalancheRpcValidationError(
        'Invalid Avalanche signed transaction',
      );
    }
  }

  /** Rejects disagreement between captured and canonical block contents. */
  private assertSameBlock(left: BlockIdentity, right: BlockIdentity): void {
    if (
      left.number !== right.number ||
      !this.sameHash(left.hash, right.hash) ||
      !this.sameHash(left.parentHash, right.parentHash) ||
      left.timestamp !== right.timestamp ||
      left.length !== right.length ||
      left.transactions.some(
        (hash, index) => !this.sameHash(hash, right.transactions[index]),
      )
    ) {
      throw new AvalancheRpcValidationError(
        'Inconsistent Avalanche canonical block',
      );
    }
  }

  /** Captures the finalized block and revalidates it by numeric canonical lookup. */
  private getFinalizedBlock = async (): Promise<BlockIdentity> => {
    const finalized = this.captureBlock(
      await this.provider.getBlock('finalized'),
    );
    const canonical = this.captureBlock(
      await this.provider.getBlock(finalized.number),
    );
    this.assertSameBlock(finalized, canonical);
    return finalized;
  };

  /** Returns the canonical finalized height on the configured chain. */
  getCurrentHeight = async (): Promise<number> => {
    await this.assertChainId();
    return (await this.getFinalizedBlock()).number;
  };

  /** Reads a validated block at or below the finalized execution frontier. */
  getBlockAtHeight = async (height: number): Promise<Block> => {
    this.assertNumber(height, 'requested height');
    await this.assertChainId();
    const finalized = await this.getFinalizedBlock();
    if (height > finalized.number) {
      throw new Error('Avalanche block execution is not settled');
    }
    const block = this.captureBlock(await this.provider.getBlock(height));
    if (block.number !== height) {
      throw new AvalancheRpcValidationError(
        'Unexpected Avalanche block number',
      );
    }
    if (height === finalized.number) {
      this.assertSameBlock(finalized, block);
    }
    return {
      hash: block.hash,
      height: block.number,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      txCount: block.length,
    };
  };

  /** Admits signed transactions with canonical inclusion and matching receipts. */
  getBlockTxs = async (
    blockHash: string,
    expectedHeight?: number,
  ): Promise<Array<TransactionResponse>> => {
    this.assertHash(blockHash, 'requested block hash');
    if (expectedHeight !== undefined) {
      this.assertNumber(expectedHeight, 'requested height');
    }
    await this.assertChainId();
    const finalized = await this.getFinalizedBlock();
    const providerBlock = await this.provider.getBlock(blockHash, true);
    const block = this.captureBlock(providerBlock);
    if (!this.sameHash(block.hash, blockHash)) {
      throw new AvalancheRpcValidationError('Unexpected Avalanche block hash');
    }
    if (expectedHeight !== undefined && block.number !== expectedHeight) {
      throw new AvalancheRpcValidationError(
        'Unexpected Avalanche transaction block height',
      );
    }
    if (block.number > finalized.number) {
      throw new Error('Avalanche block execution is not settled');
    }
    let transactions: TransactionResponse[];
    try {
      transactions = providerBlock!.prefetchedTransactions;
    } catch {
      throw new AvalancheRpcValidationError(
        'Missing Avalanche prefetched transactions',
      );
    }
    if (!Array.isArray(transactions) || transactions.length !== block.length) {
      throw new AvalancheRpcValidationError(
        'Incomplete Avalanche prefetched transactions',
      );
    }
    transactions = Array.from(transactions, (tx) =>
      this.captureTransaction(tx),
    );
    const canonical = this.captureBlock(
      await this.provider.getBlock(block.number),
    );
    this.assertSameBlock(block, canonical);
    if (block.number === finalized.number) {
      this.assertSameBlock(finalized, block);
    }
    const settledTransactions: TransactionResponse[] = [];
    for (const [index, tx] of transactions.entries()) {
      if (
        tx == null ||
        tx.chainId !== this.expectedChainId ||
        tx.blockNumber !== block.number ||
        tx.index !== index
      ) {
        throw new AvalancheRpcValidationError(
          'Inconsistent Avalanche transaction identity',
        );
      }
      this.assertHash(tx.hash, 'transaction hash');
      this.assertHash(tx.blockHash, 'transaction block hash');
      if (
        !this.sameHash(tx.hash, block.transactions[index]) ||
        !this.sameHash(tx.blockHash, block.hash)
      ) {
        throw new AvalancheRpcValidationError(
          'Inconsistent Avalanche transaction block binding',
        );
      }
      const receipt = await this.provider.getTransactionReceipt(tx.hash);
      if (receipt == null) {
        throw new Error('Missing Avalanche receipt');
      }
      if (
        receipt.blockNumber !== block.number ||
        receipt.index !== index ||
        (receipt.status !== 0 && receipt.status !== 1)
      ) {
        throw new AvalancheRpcValidationError('Inconsistent Avalanche receipt');
      }
      this.assertHash(receipt.hash, 'receipt transaction hash');
      this.assertHash(receipt.blockHash, 'receipt block hash');
      if (
        !this.sameHash(receipt.hash, tx.hash) ||
        !this.sameHash(receipt.blockHash, block.hash)
      ) {
        throw new AvalancheRpcValidationError(
          'Inconsistent Avalanche receipt block binding',
        );
      }
      settledTransactions.push(new SettledTransactionResponse(tx, receipt));
    }
    return settledTransactions;
  };
}
