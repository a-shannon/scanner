import { Transaction, TransactionReceipt, TransactionResponse } from 'ethers';

import { BlockInfo } from '@rosen-bridge/scanner-interfaces';

const transferTopic =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Compare complete hexadecimal identities without depending on letter case. */
const sameHex = (left: unknown, right: unknown, bytes: number) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(left) &&
  new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(right) &&
  left.toLowerCase() === right.toLowerCase();

/**
 * Require one canonical standard ERC20 Transfer for an Avalanche lock request.
 * Amounts are compared in raw contract units before TokenMap decimal wrapping.
 */
export const hasAvalancheTransferProof = (
  transaction: TransactionResponse,
  receipt: TransactionReceipt,
  block: BlockInfo,
  lockAddress: string,
): boolean => {
  try {
    const signed = Transaction.from(transaction);
    const calldata = signed.data;
    if (
      signed.hash === null ||
      signed.from === null ||
      signed.to === null ||
      !sameHex(signed.hash, transaction.hash, 32) ||
      (signed.chainId !== 43113n && signed.chainId !== 43114n) ||
      !/^0xa9059cbb[0-9a-fA-F]{128}/.test(calldata) ||
      calldata.slice(10, 34) !== '0'.repeat(24) ||
      !sameHex('0x' + calldata.slice(34, 74), lockAddress, 20) ||
      receipt.status !== 1 ||
      !sameHex(receipt.hash, signed.hash, 32) ||
      !sameHex(receipt.blockHash, block.hash, 32) ||
      !sameHex(transaction.blockHash, block.hash, 32) ||
      receipt.blockNumber !== block.height ||
      transaction.blockNumber !== block.height ||
      !Number.isSafeInteger(receipt.index) ||
      receipt.index < 0 ||
      receipt.index !== transaction.index ||
      !sameHex(receipt.from, signed.from, 20) ||
      !sameHex(receipt.to, signed.to, 20) ||
      !Array.isArray(receipt.logs)
    )
      return false;

    const transfers = receipt.logs.filter(
      (log) =>
        sameHex(log.address, signed.to, 20) &&
        log.topics[0]?.toLowerCase() === transferTopic,
    );
    if (transfers.length !== 1) return false;
    const log = transfers[0];
    const sender = '0x' + signed.from.slice(2).toLowerCase().padStart(64, '0');
    const recipient =
      '0x' + lockAddress.slice(2).toLowerCase().padStart(64, '0');
    return (
      log.removed === false &&
      sameHex(log.transactionHash, signed.hash, 32) &&
      sameHex(log.blockHash, block.hash, 32) &&
      log.blockNumber === block.height &&
      log.transactionIndex === receipt.index &&
      Number.isSafeInteger(log.index) &&
      log.index >= 0 &&
      receipt.logs.filter((candidate) => candidate.index === log.index)
        .length === 1 &&
      log.topics.length === 3 &&
      sameHex(log.topics[1], sender, 32) &&
      sameHex(log.topics[2], recipient, 32) &&
      /^0x[0-9a-fA-F]{64}$/.test(log.data) &&
      BigInt(log.data) === BigInt('0x' + calldata.slice(74, 138))
    );
  } catch {
    return false;
  }
};
