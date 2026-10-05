import { describe, expect, it } from 'vitest';

import { HttpSolanaRpc } from '../lib/rpc/httpSolanaRpc';

const hash = '1'.repeat(32);
const signature = '1'.repeat(64);
/** Builds a finalized block fixture with stable hashes and one transaction. */
const finalizedBlock = (slot: number, blockHeight = 50) => ({
  slot,
  blockHeight,
  blockhash: hash,
  parentSlot: slot - 1,
  previousBlockhash: hash,
  blockTime: 1_700_000_000,
  transactions: [{ transaction: { signatures: [signature] } }],
});

/** Creates an HTTP RPC client backed by a deterministic handler and call log. */
const makeRpc = (
  handler: (method: string, params: unknown[]) => unknown,
  bounds: { maxResponseBytes?: number } = {},
) => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: string;
      method: string;
      params: unknown[];
    };
    calls.push({ method: request.method, params: request.params });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: handler(request.method, request.params),
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  return {
    calls,
    rpc: new HttpSolanaRpc({
      endpoint: 'https://solana.example/rpc',
      fetcher,
      ...bounds,
    }),
  };
};

describe('HttpSolanaRpc', () => {
  /**
   * @target HttpSolanaRpc.getFinalizedHead derives the finalized head from produced finalized blocks
   * @dependencies injected RPC handler and finalized block fixture
   * @scenario return the highest finalized slot and its produced block
   * @expected the finalized head contains the returned slot, height, hash, and commitment
   */
  it('derives the finalized head from produced finalized blocks', async () => {
    const { calls, rpc } = makeRpc((method) => {
      if (method === 'getSlot') return 109;
      if (method === 'getBlock') return finalizedBlock(109, 52);
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(rpc.getFinalizedHead()).resolves.toEqual({
      slot: 109,
      blockHeight: 52,
      blockhash: hash,
      commitment: 'finalized',
    });
    expect(calls).toEqual([
      { method: 'getSlot', params: [{ commitment: 'finalized' }] },
      {
        method: 'getBlock',
        params: [
          109,
          {
            commitment: 'finalized',
            encoding: 'json',
            transactionDetails: 'full',
            rewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      },
    ]);
  });

  /**
   * @target HttpSolanaRpc.getFinalizedHead holds when the exact finalized slot has no block
   * @dependencies injected RPC handler returning a null block at the finalized slot
   * @scenario resolve the finalized slot and request its unavailable block
   * @expected the call fails with HISTORY_GAP and records both RPC methods
   */
  it('holds when the exact finalized slot has no block', async () => {
    const { calls, rpc } = makeRpc((method) => {
      if (method === 'getSlot') return 109;
      if (method === 'getBlock') return null;
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(rpc.getFinalizedHead()).rejects.toMatchObject({
      name: 'SolanaScannerFault',
      code: 'HISTORY_GAP',
      rpcMethod: 'getBlock',
    });
    expect(calls.map(({ method }) => method)).toEqual(['getSlot', 'getBlock']);
  });

  /**
   * @target HttpSolanaRpc.getBlock classifies required block history error %i as persistent
   * @dependencies injected JSON-RPC errors for required historical block codes
   * @scenario request a finalized block for each listed persistent RPC error
   * @expected every error becomes a SolanaScannerFault with HISTORY_GAP and its original code
   */
  it.each([-32001, -32007, -32009, -32011, -32021])(
    'classifies required block history error %i as persistent',
    async (rpcCode) => {
      const fetcher: typeof fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: string };
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: rpcCode, message: 'synthetic' },
          }),
        );
      };
      const rpc = new HttpSolanaRpc({
        endpoint: 'https://solana.example/rpc',
        fetcher,
      });

      await expect(
        rpc.getBlock(109, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        }),
      ).rejects.toMatchObject({
        name: 'SolanaScannerFault',
        code: 'HISTORY_GAP',
        rpcMethod: 'getBlock',
        rpcCode,
      });
    },
  );

  /**
   * @target HttpSolanaRpc.getBlock classifies unsupported transaction version as persistent and retains its code
   * @dependencies injected unsupported-transaction-version RPC error
   * @scenario request a finalized block when the endpoint rejects transaction version zero
   * @expected the call fails with BLOCK_VERSION_UNSUPPORTED and preserves the RPC code
   */
  it('classifies unsupported transaction version as persistent and retains its code', async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32015, message: 'synthetic' },
        }),
      );
    };
    const rpc = new HttpSolanaRpc({
      endpoint: 'https://solana.example/rpc',
      fetcher,
    });

    await expect(
      rpc.getBlock(109, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    ).rejects.toMatchObject({
      name: 'SolanaScannerFault',
      code: 'BLOCK_VERSION_UNSUPPORTED',
      rpcMethod: 'getBlock',
      rpcCode: -32015,
    });
  });

  /**
   * @target HttpSolanaRpc.getBlock keeps retryable or unknown block RPC error %i unavailable
   * @dependencies injected RPC errors outside the persistent history-error set
   * @scenario request a finalized block for each listed retryable or unknown code
   * @expected every error remains SolanaRpcUnavailableError with RPC_METHOD_ERROR and its original code
   */
  it.each([-32004, -32005, -32014, -32016, -32019, -32099])(
    'keeps retryable or unknown block RPC error %i unavailable',
    async (rpcCode) => {
      const fetcher: typeof fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: string };
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: rpcCode, message: 'synthetic' },
          }),
        );
      };
      const rpc = new HttpSolanaRpc({
        endpoint: 'https://solana.example/rpc',
        fetcher,
      });

      await expect(
        rpc.getBlock(109, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        }),
      ).rejects.toMatchObject({
        name: 'SolanaRpcUnavailableError',
        code: 'RPC_METHOD_ERROR',
        rpcMethod: 'getBlock',
        rpcCode,
      });
    },
  );

  /**
   * @target HttpSolanaRpc.getBlock retains the exact block JSON, including unsafe numeric source tokens
   * @dependencies injected raw block response containing an integer outside JavaScript safe range
   * @scenario fetch a finalized block and inspect its retained response and extracted transaction
   * @expected raw JSON is byte-for-byte retained while the first signature is indexed
   */
  it('retains the exact block JSON, including unsafe numeric source tokens', async () => {
    let responseBody = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      responseBody =
        `{"jsonrpc":"2.0","id":"${request.id}","result":` +
        `{"slot":105,"blockHeight":51,"blockhash":"${hash}",` +
        `"parentSlot":100,"previousBlockhash":"${hash}",` +
        `"blockTime":1700000000,"wideValue":9007199254740993,` +
        `"transactions":[{"transaction":{"signatures":["${signature}"]}}]}}`;
      return new Response(responseBody);
    };
    const rpc = new HttpSolanaRpc({
      endpoint: 'https://solana.example/rpc',
      fetcher,
    });

    const block = await rpc.getBlock(105, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    expect(block?.rawResponse).toBe(responseBody);
    expect(block?.transactions).toEqual([{ signature, transactionIndex: 0 }]);
  });

  /**
   * @target HttpSolanaRpc.getBlock rejects an invalid finalized block height as a content fault
   * @dependencies finalized block fixture with a null block height
   * @scenario fetch the malformed finalized block
   * @expected the response is rejected with BLOCK_HEIGHT
   */
  it('rejects an invalid finalized block height as a content fault', async () => {
    const { rpc } = makeRpc(() => ({
      ...finalizedBlock(109),
      blockHeight: null,
    }));

    await expect(
      rpc.getBlock(109, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    ).rejects.toMatchObject({
      name: 'SolanaScannerFault',
      code: 'BLOCK_HEIGHT',
    });
  });

  /**
   * @target HttpSolanaRpc.getBlock rejects duplicate first signatures in a finalized block
   * @dependencies finalized block fixture with the same first signature in two transactions
   * @scenario fetch the block containing duplicate transaction identifiers
   * @expected the response is rejected with DUPLICATE_TRANSACTION
   */
  it('rejects duplicate first signatures in a finalized block', async () => {
    const { rpc } = makeRpc(() => ({
      ...finalizedBlock(109),
      transactions: [
        { transaction: { signatures: [signature] } },
        { transaction: { signatures: [signature] } },
      ],
    }));

    await expect(
      rpc.getBlock(109, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    ).rejects.toMatchObject({
      name: 'SolanaScannerFault',
      code: 'DUPLICATE_TRANSACTION',
    });
  });

  /**
   * @target HttpSolanaRpc.getGenesisHash preserves the response-byte cap as a bounded RPC failure
   * @dependencies injected response body exceeding the configured byte bound
   * @scenario request the genesis hash with a smaller maximum response size
   * @expected the request fails with RPC_RESPONSE_BOUND
   */
  it('preserves the response-byte cap as a bounded RPC failure', async () => {
    const fetcher: typeof fetch = async () => new Response('x'.repeat(2048));
    const rpc = new HttpSolanaRpc({
      endpoint: 'https://solana.example/rpc',
      fetcher,
      maxResponseBytes: 1024,
    });

    await expect(rpc.getGenesisHash()).rejects.toMatchObject({
      name: 'SolanaRpcUnavailableError',
      code: 'RPC_RESPONSE_BOUND',
    });
  });
});
