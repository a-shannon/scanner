import type { JsonRpcProvider as RpcProvider } from 'ethers';
import { vi } from 'vitest';

/** Use the real ethers provider constructor for scoped loopback transport tests. */
export const mockRealJsonRpcProvider = async () => {
  const { JsonRpcProvider } = await import('ethers');
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  const provider = vi.mocked(JsonRpcProvider);
  const previous = provider.getMockImplementation();
  if (!previous)
    throw new Error('Expected the shared provider constructor mock');
  provider.mockImplementation(
    (...args: ConstructorParameters<typeof RpcProvider>) =>
      new actual.JsonRpcProvider(...args),
  );
  return () => provider.mockImplementation(previous);
};
