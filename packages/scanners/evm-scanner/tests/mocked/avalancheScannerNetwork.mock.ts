import { vi } from 'vitest';

import { AvalancheRpcNetwork } from '../../lib/avalancheRpcNetwork';
import { block } from '../avalancheScannerTestUtils';

/** Supply a settled height, contiguous headers and empty transaction batches. */
export const mockScannerNetwork = (network: AvalancheRpcNetwork) => {
  vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(3);
  vi.spyOn(network, 'getBlockAtHeight').mockImplementation(async (height) =>
    block(height),
  );
  vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
};
