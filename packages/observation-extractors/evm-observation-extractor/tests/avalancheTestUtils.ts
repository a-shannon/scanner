import {
  JsonRpcProvider,
  Transaction,
  TransactionLike,
  TransactionResponse,
  TransactionResponseParams,
  TransactionReceiptParams,
} from 'ethers';

import { chainValidators, chainDecoders } from '@rosen-bridge/address-codec';
import { AddressManager } from '@rosen-bridge/address-manager';
import { TokenMap } from '@rosen-bridge/tokens';

import {
  derivedBlockHash,
  lockAddress,
  rawData,
  tokenConfig,
  joeAddress,
  joeCallData,
  settledBlock,
} from './avalancheTestData';

/** Register the chain validators and decoders used by these synthetic fixtures. */
export const initializeAddressManager = () =>
  AddressManager.init(chainValidators, chainDecoders);

/** Load the supplied synthetic token mappings into the real TokenMap. */
export const createTokenMap = async (config = tokenConfig) => {
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(config);
  return tokens;
};

/** Encode an ERC20 transfer to the selected recipient followed by Rosen metadata. */
export const erc20Data = (recipient = lockAddress) =>
  '0xa9059cbb' +
  recipient.slice(2).padStart(64, '0') +
  3305307248n.toString(16).padStart(64, '0') +
  rawData;

// Synthetic signed transaction shapes; no key, RPC call or broadcast is used.
/** Build a synthetic signed transaction response without a signing key or RPC call. */
export const createTransaction = (overrides: TransactionLike = {}) => {
  const transaction = Transaction.from({
    type: 2,
    to: lockAddress,
    data: '0x' + rawData,
    nonce: 10,
    gasLimit: 21000n,
    maxPriorityFeePerGas: 500000000n,
    maxFeePerGas: 48978500000n,
    value: 92850988521632054n,
    chainId: 43113n,
    accessList: [],
    signature: {
      r: '0x' + '01'.repeat(32),
      s: '0x' + '02'.repeat(32),
      yParity: 0,
    },
    ...overrides,
  });
  return new TransactionResponse(
    transaction as unknown as TransactionResponseParams,
    new JsonRpcProvider(),
  );
};

/** Attach the original mined block metadata to the synthetic signed response. */
export const createMinedTransaction = () => {
  const tx = createTransaction();
  Object.defineProperties(tx, {
    blockHash: { value: derivedBlockHash },
    blockNumber: { value: 10 },
  });
  return tx;
};

/** Attach complete canonical mined identities to a synthetic transaction. */
export const attachMinedIdentity = (tx: TransactionResponse) => {
  Object.defineProperties(tx, {
    blockHash: { value: derivedBlockHash, configurable: true },
    blockNumber: { value: 10, configurable: true },
    index: { value: 0, configurable: true },
  });
  return tx;
};

/** Build canonical receipt evidence for a synthetic standard ERC20 transfer. */
export const createTransferReceipt = (
  tx: TransactionResponse,
): TransactionReceiptParams => ({
  hash: tx.hash,
  blockHash: derivedBlockHash,
  blockNumber: 10,
  index: 0,
  status: 1,
  to: tx.to,
  from: tx.from,
  contractAddress: null,
  logsBloom: '0x' + '00'.repeat(256),
  gasUsed: 100000n,
  cumulativeGasUsed: 100000n,
  gasPrice: 1n,
  type: 2,
  root: null,
  logs: [
    {
      address: tx.to!,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x' + tx.from.slice(2).toLowerCase().padStart(64, '0'),
        '0x' + lockAddress.slice(2).padStart(64, '0'),
      ],
      data: '0x' + tx.data.slice(74, 138),
      transactionHash: tx.hash,
      blockHash: derivedBlockHash,
      blockNumber: 10,
      transactionIndex: 0,
      index: 0,
      removed: false,
    },
  ],
});

/** Replay the frozen generic UI mainnet producer output with a synthetic signature. */
export const createJoeMainnetTransaction = () =>
  attachMinedIdentity(
    createTransaction({
      chainId: 43114n,
      gasLimit: 100000n,
      to: joeAddress,
      value: 0n,
      data: joeCallData,
    }),
  );

/** Attach a supplied transaction to the synthetic canonical settled block. */
export const createSettledBlock = (tx: TransactionResponse) => ({
  number: settledBlock.height,
  hash: settledBlock.hash,
  parentHash: settledBlock.parentHash,
  timestamp: settledBlock.timestamp,
  length: 1,
  transactions: [tx.hash],
  prefetchedTransactions: [tx],
});
