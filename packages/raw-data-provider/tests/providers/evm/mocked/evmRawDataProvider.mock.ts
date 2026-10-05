import { TransactionReceipt, TransactionResponse } from 'ethers';
import { vi } from 'vitest';

/** Mock a mined transaction receipt for a successful replay wait. */
export const mockSuccessfulReceipt = (tx: TransactionResponse) =>
  vi.spyOn(tx, 'wait').mockResolvedValue({} as TransactionReceipt);
