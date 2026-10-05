import {
  JsonRpcProvider,
  Transaction,
  TransactionResponse,
  TransactionResponseParams,
} from 'ethers';

import { TokenMap } from '@rosen-bridge/tokens';

import {
  lockAddress,
  rawData,
  blockHash,
  asset,
} from './evmRawDataProviderTestData';

/**
 * Build the selected native asset mapping for deterministic replay tests.
 */
export const createTokenMap = async (chain = 'ethereum', native = 'eth') => {
  const tokens = new TokenMap();
  await tokens.updateConfigByJson([
    {
      [chain]: { ...asset, tokenId: native, decimals: 18 },
      ergo: { ...asset, tokenId: '44'.repeat(32), decimals: 9 },
    },
  ]);
  return tokens;
};

/**
 * Create a signed synthetic transaction at the selected nonce and chain ID.
 */
export const createTransaction = (nonce = 10, chainId = 1n) => {
  const tx = new TransactionResponse(
    Transaction.from({
      type: 2,
      to: lockAddress,
      data: '0x' + rawData,
      nonce,
      gasLimit: 21000n,
      maxPriorityFeePerGas: 500000000n,
      maxFeePerGas: 48978500000n,
      value: 92850988521632054n,
      chainId,
      accessList: [],
      signature: {
        r: '0x' + '01'.repeat(32),
        s: '0x' + '02'.repeat(32),
        yParity: 0,
      },
    }) as unknown as TransactionResponseParams,
    new JsonRpcProvider(),
  );
  Object.defineProperties(tx, {
    blockHash: { value: blockHash },
    blockNumber: { value: 10 },
  });
  return tx;
};
