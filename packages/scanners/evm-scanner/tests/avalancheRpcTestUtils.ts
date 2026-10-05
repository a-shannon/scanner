import { Transaction, TransactionResponse } from 'ethers';

import { AvalancheRpcNetwork } from '../lib/avalancheRpcNetwork';
import { chainId } from './avalancheTestData';
import { rpc } from './mocked/avalancheRpc.mock';

/**
 * Build a canonical synthetic block or transaction hash.
 */
export const hash = (byte: string) => `0x${byte.repeat(64)}`;

/**
 * Create a signed synthetic transaction response with the selected chain ID.
 */
export const transaction = (
  index: number,
  id = chainId,
): TransactionResponse => {
  const signed = Transaction.from({
    type: 2,
    chainId: id,
    nonce: index,
    to: `0x${'12'.repeat(20)}`,
    gasLimit: 21000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    value: 5n,
    // Synthetic signatures; these fixtures do not use signing keys.
    signature: {
      r: `0x${'01'.repeat(32)}`,
      s: `0x${'02'.repeat(32)}`,
      v: 27,
    },
  });
  return {
    type: signed.type,
    chainId: signed.chainId,
    nonce: signed.nonce,
    to: signed.to,
    from: signed.from,
    gasLimit: signed.gasLimit,
    maxFeePerGas: signed.maxFeePerGas,
    maxPriorityFeePerGas: signed.maxPriorityFeePerGas,
    value: signed.value,
    data: signed.data,
    accessList: signed.accessList,
    signature: signed.signature,
    hash: signed.hash,
    blockHash: hash('1'),
    blockNumber: 10,
    index,
    provider: rpc,
  } as unknown as TransactionResponse;
};

/**
 * Prepare matching finalized, canonical, transaction and receipt responses.
 */
export const fixture = (id = chainId) => {
  const transactions = [transaction(0, id), transaction(1, id)];
  const block = {
    number: 10,
    hash: hash('1'),
    parentHash: hash('2'),
    timestamp: 100,
    length: transactions.length,
    transactions: transactions.map((tx) => tx.hash),
    prefetchedTransactions: transactions,
  };
  const canonical = { ...block, transactions: [...block.transactions] };
  const finalized = {
    number: 20,
    hash: hash('3'),
    parentHash: hash('4'),
    timestamp: 200,
    length: 0,
    transactions: [] as string[],
    prefetchedTransactions: [] as TransactionResponse[],
  };
  const receipts = transactions.map((tx) => ({
    hash: tx.hash,
    blockHash: tx.blockHash,
    blockNumber: tx.blockNumber,
    index: tx.index,
    status: 1,
    to: tx.to,
    from: tx.from,
    contractAddress: null,
    logsBloom: '0x' + '00'.repeat(256),
    gasUsed: 21000n,
    cumulativeGasUsed: 21000n,
    gasPrice: 1n,
    type: 2,
    root: null,
    logs: [],
  }));
  rpc.send.mockResolvedValue(`0x${id.toString(16)}`);
  rpc.getBlock.mockImplementation(async (tag: string | number) => {
    if (tag === 'finalized' || tag === finalized.number) return finalized;
    if (tag === block.hash) return block;
    if (tag === block.number) return canonical;
    return null;
  });
  rpc.getTransactionReceipt.mockImplementation(async (txHash: string) =>
    receipts.find((receipt) => receipt.hash === txHash),
  );
  return { block, canonical, finalized, transactions, receipts };
};

/**
 * Invoke the selected public read operation against the synthetic RPC adapter.
 */
export const run = (
  network: AvalancheRpcNetwork,
  operation: 'getCurrentHeight' | 'getBlockAtHeight' | 'getBlockTxs',
) => {
  if (operation === 'getCurrentHeight') return network.getCurrentHeight();
  if (operation === 'getBlockAtHeight') return network.getBlockAtHeight(10);
  return network.getBlockTxs(hash('1'));
};
