import { vi } from 'vitest';

/** Mock chain identity, finalized/canonical blocks, height and transaction receipts. */
export const rpc = {
  send: vi.fn(),
  getBlock: vi.fn(),
  getBlockNumber: vi.fn(),
  getTransactionReceipt: vi.fn(),
  _getConnection: () => ({ timeout: 0 }),
};
