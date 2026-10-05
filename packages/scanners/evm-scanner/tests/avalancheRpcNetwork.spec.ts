import {
  isCallException,
  Transaction,
  TransactionReceipt,
  TransactionResponse,
} from 'ethers';
import { createServer, Server } from 'node:http';
import { vi } from 'vitest';

import {
  AvalancheRpcNetwork,
  AvalancheRpcValidationError,
} from '../lib/avalancheRpcNetwork';
import { fixture, hash, run } from './avalancheRpcTestUtils';
import { chainId } from './avalancheTestData';
import { rpc } from './mocked/avalancheRpc.mock';
import { mockRealJsonRpcProvider } from './mocked/realJsonRpcProvider.mock';

vi.mock('ethers', async (importOriginal) => {
  const { rpc } = await import('./mocked/avalancheRpc.mock');
  return {
    ...(await importOriginal<typeof import('ethers')>()),
    JsonRpcProvider: vi.fn().mockImplementation(() => rpc),
  };
});

describe('AvalancheRpcNetwork', () => {
  let network: AvalancheRpcNetwork;

  let data: ReturnType<typeof fixture>;

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.send.mockReset();
    rpc.getBlock.mockReset();
    rpc.getBlockNumber.mockReset();
    rpc.getTransactionReceipt.mockReset();
    network = new AvalancheRpcNetwork('https://rpc.invalid', chainId, 1000);
    data = fixture();
  });

  describe('constructor', () => {
    describe('transport', () => {
      const networks: AvalancheRpcNetwork[] = [];
      let server: Server | undefined;
      afterEach(async () => {
        networks.splice(0).forEach((network) => network['provider'].destroy());
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
          server = undefined;
        }
      });
      let restoreProvider: () => void;
      beforeEach(async () => {
        restoreProvider = await mockRealJsonRpcProvider();
      });
      afterEach(() => restoreProvider());

      /**
       * @target AvalancheRpcNetwork.constructor rejects an invalid explicit
       * Avalanche timeout (%s)
       * @dependencies
       * - Loopback HTTP server and synthetic JSON-RPC request.
       * @scenario
       * - Construct Avalanche adapters with each invalid explicit timeout.
       * @expected
       * - Timeout validation rejects.
       */
      it.each([0, -1, 0.5, NaN, Infinity, 2147483648])(
        'rejects an invalid explicit Avalanche timeout (%s)',
        (timeout) => {
          expect(
            () =>
              new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n, timeout),
          ).toThrow('Invalid Avalanche RPC timeout');
        },
      );

      /**
       * @target AvalancheRpcNetwork.constructor times out a stalled local HTTP
       * response using the configured deadline
       * @dependencies
       * - Loopback HTTP server and synthetic JSON-RPC request.
       * @scenario
       * - Start a stalled loopback HTTP server and issue a request with a 100
       * millisecond deadline.
       * @expected
       * - The request rejects with TIMEOUT.
       */
      it('times out a stalled local HTTP response using the configured deadline', async () => {
        server = createServer(() => {
          // Deliberately leave the response open until the RPC deadline expires.
        });
        await new Promise<void>((resolve) =>
          server!.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('No server port');
        const network = new AvalancheRpcNetwork(
          `http://127.0.0.1:${address.port}`,
          43113n,
          100,
        );
        networks.push(network);
        await expect(
          network['provider']._send({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_chainId',
            params: [],
          }),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
      });
      /**
       * @target AvalancheRpcNetwork.constructor preserves raw receipt removed flags (%s)
       * @dependencies Real ethers JsonRpcProvider, loopback HTTP and a synthetic receipt
       * @scenario Return the selected raw removed value through the actual ethers receipt formatter
       * @expected Preserve the exact value without converting absent or invalid values to false
       */
      it.each([false, true, undefined, null, 0, 'false'])(
        'preserves raw receipt removed flags (%s)',
        async (removed) => {
          const tx = data.transactions[0];
          const log = {
            address: tx.to,
            blockHash: hash('1'),
            blockNumber: '0xa',
            transactionHash: tx.hash,
            transactionIndex: '0x0',
            logIndex: '0x0',
            topics: [hash('a')],
            data: '0x',
            ...(removed === undefined ? {} : { removed }),
          };
          const rawReceipt = {
            to: tx.to,
            from: tx.from,
            transactionHash: tx.hash,
            transactionIndex: '0x0',
            blockHash: hash('1'),
            blockNumber: '0xa',
            gasUsed: '0x5208',
            cumulativeGasUsed: '0x5208',
            effectiveGasPrice: '0x1',
            status: '0x1',
            type: '0x2',
            logsBloom: '0x' + '00'.repeat(256),
            logs: [log],
          };
          const calls: string[] = [];
          server = createServer((request, response) => {
            let input = '';
            request.on('data', (chunk) => (input += chunk));
            request.on('end', () => {
              const payload = JSON.parse(input);
              const answer = (item: { id: number; method: string }) => {
                calls.push(item.method);
                return {
                  jsonrpc: '2.0',
                  id: item.id,
                  result: item.method === 'eth_chainId' ? '0xa86a' : rawReceipt,
                };
              };
              response.setHeader('content-type', 'application/json');
              response.end(
                JSON.stringify(
                  Array.isArray(payload)
                    ? payload.map(answer)
                    : answer(payload),
                ),
              );
            });
          });
          await new Promise<void>((resolve) =>
            server!.listen(0, '127.0.0.1', resolve),
          );
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('No server port');
          const actual = new AvalancheRpcNetwork(
            `http://127.0.0.1:${address.port}`,
            43114n,
            1000,
          );
          networks.push(actual);
          const receipt = await actual['provider'].getTransactionReceipt(
            tx.hash,
          );
          expect(receipt?.logs[0].removed).toEqual(removed);
          expect(receipt?.logs[0]).toMatchObject({
            transactionHash: tx.hash,
            blockHash: hash('1'),
            blockNumber: 10,
            index: 0,
          });
          expect(
            calls.filter((method) => method === 'eth_getTransactionReceipt'),
          ).toHaveLength(1);
        },
      );
    });

    /**
     * @target AvalancheRpcNetwork.constructor rejects unsupported configured
     * chain %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Construct an adapter for each unsupported chain ID.
     * @expected
     * - Construction rejects the unsupported ID.
     */
    it.each([0n, 1n, 43112n, 43115n])(
      'rejects unsupported configured chain %s',
      (id) => {
        expect(
          () => new AvalancheRpcNetwork('https://rpc.invalid', id),
        ).toThrow('C-Chain ID');
      },
    );

    /**
     * @target AvalancheRpcNetwork.constructor supports explicit chain %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Select each supported chain ID
     * - read its height and transactions.
     * @expected
     * - Height is 20 and two transactions are qualified.
     */
    it.each([43113n, 43114n])('supports explicit chain %s', async (id) => {
      fixture(id);
      const configured = new AvalancheRpcNetwork('https://rpc.invalid', id);
      await expect(configured.getCurrentHeight()).resolves.toEqual(20);
      await expect(configured.getBlockTxs(hash('1'))).resolves.toHaveLength(2);
    });
  });

  describe('getCurrentHeight', () => {
    /**
     * @target AvalancheRpcNetwork.getCurrentHeight getCurrentHeight rechecks
     * raw chain identity on each operation
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Run the operation, change eth_chainId, and run it again.
     * @expected
     * - The second call rejects and re-reads raw chain identity.
     */
    it('getCurrentHeight rechecks raw chain identity on each operation', async () => {
      const operation = 'getCurrentHeight' as const;

      await run(network, operation);
      rpc.send.mockResolvedValue('0xa86a');
      await expect(async () => {
        await run(network, operation);
      }).rejects.toThrow('C-Chain ID');
      expect(rpc.send).toHaveBeenCalledTimes(2);
      expect(rpc.send).toHaveBeenLastCalledWith('eth_chainId', []);
    });

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight rejects malformed or
     * unexpected chain quantity %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return each malformed or unexpected eth_chainId response.
     * @expected
     * - The request rejects before reading any block.
     */
    it.each([
      null,
      undefined,
      43113,
      43113n,
      '43113',
      '0x0a869',
      '0xA869',
      '0X a869',
      '0x',
      '0x0',
    ])('rejects malformed or unexpected chain quantity %s', async (id) => {
      rpc.send.mockResolvedValue(id);
      await expect(async () => {
        await network.getCurrentHeight();
      }).rejects.toThrow('C-Chain ID');
      expect(rpc.getBlock).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight returns the settled height
     * and binds its numeric canonical block
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return matching finalized and numeric canonical blocks.
     * @expected
     * - Height is 20, with no latest-height query.
     */
    it('returns the settled height and binds its numeric canonical block', async () => {
      await expect(network.getCurrentHeight()).resolves.toEqual(20);
      expect(rpc.getBlock.mock.calls).toEqual([['finalized'], [20]]);
      expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight captures finalized %s
     * before its canonical lookup
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Mutate the selected finalized field during canonical lookup.
     * @expected
     * - The changed response rejects against the captured identity.
     */
    it.each([
      'number',
      'hash',
      'parentHash',
      'timestamp',
      'transactions',
    ] as const)(
      'captures finalized %s before its canonical lookup',
      async (field) => {
        data.finalized.length = 1;
        data.finalized.transactions = [hash('5')];
        rpc.getBlock.mockImplementation(async (tag: string | number) => {
          if (tag === 'finalized') return data.finalized;
          if (tag === 20) {
            if (field === 'transactions')
              data.finalized.transactions[0] = hash('6');
            else if (field === 'number') data.finalized.number = 21;
            else if (field === 'timestamp') data.finalized.timestamp = 201;
            else data.finalized[field] = hash('f');
            return data.finalized;
          }
          return null;
        });
        await expect(async () => {
          await network.getCurrentHeight();
        }).rejects.toThrow(Error);
      },
    );

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight getCurrentHeight fails
     * without a finalized result instead of falling back
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return no finalized block and invoke the selected operation.
     * @expected
     * - The operation rejects with no latest-height fallback.
     */
    it('getCurrentHeight fails without a finalized result instead of falling back', async () => {
      const operation = 'getCurrentHeight' as const;

      rpc.getBlock.mockResolvedValue(null);
      await expect(async () => {
        await run(network, operation);
      }).rejects.toThrow(Error);
      expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight propagates unsupported
     * finalized-tag errors
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Reject the finalized-tag lookup with a transport error.
     * @expected
     * - The original error message propagates after one lookup.
     */
    it('propagates unsupported finalized-tag errors', async () => {
      rpc.getBlock.mockRejectedValue(new Error('unsupported finalized tag'));
      await expect(async () => {
        await network.getCurrentHeight();
      }).rejects.toThrow('unsupported finalized tag');
      expect(rpc.getBlock).toHaveBeenCalledTimes(1);
    });

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight rejects a
     * finalized/canonical %s mismatch
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return finalized and canonical blocks differing in the selected field.
     * @expected
     * - The mismatch rejects.
     */
    it.each(['hash', 'number', 'parentHash', 'timestamp', 'length'] as const)(
      'rejects a finalized/canonical %s mismatch',
      async (field) => {
        const wrong = {
          ...data.finalized,
          [field]: typeof data.finalized[field] === 'number' ? 21 : hash('f'),
        };
        rpc.getBlock
          .mockResolvedValueOnce(data.finalized)
          .mockResolvedValueOnce(wrong);
        await expect(async () => {
          await network.getCurrentHeight();
        }).rejects.toThrow(Error);
      },
    );

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight rejects invalid finalized
     * height %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Replace the finalized height with each invalid numeric value.
     * @expected
     * - Block-number validation rejects.
     */
    it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
      'rejects invalid finalized height %s',
      async (number) => {
        data.finalized.number = number;
        await expect(async () => {
          await network.getCurrentHeight();
        }).rejects.toThrow('block number');
      },
    );

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight rejects invalid finalized
     * hash %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Replace the finalized hash with each invalid hash shape.
     * @expected
     * - Block-hash validation rejects.
     */
    it.each(['0x1234', hash('0'), 'not-a-hash'])(
      'rejects invalid finalized hash %s',
      async (value) => {
        data.finalized.hash = value;
        await expect(async () => {
          await network.getCurrentHeight();
        }).rejects.toThrow('block hash');
      },
    );

    /**
     * @target AvalancheRpcNetwork.getCurrentHeight does not relabel transport
     * errors as validation failures
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Reject eth_chainId with a specific Error instance.
     * @expected
     * - The exact original Error instance propagates.
     */
    it('does not relabel transport errors as validation failures', async () => {
      const failure = new Error('RPC unavailable');
      rpc.send.mockRejectedValue(failure);
      await expect(network.getCurrentHeight()).rejects.toBe(failure);
    });
  });

  describe('getBlockAtHeight', () => {
    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight getBlockAtHeight rechecks
     * raw chain identity on each operation
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Run the operation, change eth_chainId, and run it again.
     * @expected
     * - The second call rejects and re-reads raw chain identity.
     */
    it('getBlockAtHeight rechecks raw chain identity on each operation', async () => {
      const operation = 'getBlockAtHeight' as const;

      await run(network, operation);
      rpc.send.mockResolvedValue('0xa86a');
      await expect(async () => {
        await run(network, operation);
      }).rejects.toThrow('C-Chain ID');
      expect(rpc.send).toHaveBeenCalledTimes(2);
      expect(rpc.send).toHaveBeenLastCalledWith('eth_chainId', []);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight refuses a frontier raised
     * above its captured height during canonical lookup
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Raise a captured frontier of 9 during its canonical lookup
     * - request 10.
     * @expected
     * - The request rejects before looking up height 10.
     */
    it('refuses a frontier raised above its captured height during canonical lookup', async () => {
      data.finalized.number = 9;
      rpc.getBlock.mockImplementation(async (tag: string | number) => {
        if (tag === 'finalized') return data.finalized;
        if (tag === 9) {
          data.finalized.number = 20;
          return data.finalized;
        }
        if (tag === 10) return data.canonical;
        return null;
      });
      await expect(async () => {
        await network.getBlockAtHeight(10);
      }).rejects.toThrow(Error);
      expect(rpc.getBlock).not.toHaveBeenCalledWith(10);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight retains finalized identity
     * across the subsequent header lookup
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Change the finalized identity during the subsequent header lookup.
     * @expected
     * - The conflicting canonical block rejects.
     */
    it('retains finalized identity across the subsequent header lookup', async () => {
      rpc.getBlock.mockImplementation(async (tag: string | number) => {
        if (tag === 'finalized') return data.finalized;
        if (tag === 20 && rpc.getBlock.mock.calls.length === 2)
          return data.finalized;
        data.finalized.number = 21;
        return { ...data.finalized, number: 20, hash: hash('f') };
      });
      await expect(async () => {
        await network.getBlockAtHeight(20);
      }).rejects.toThrow('canonical block');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight getBlockAtHeight fails
     * without a finalized result instead of falling back
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return no finalized block and invoke the selected operation.
     * @expected
     * - The operation rejects with no latest-height fallback.
     */
    it('getBlockAtHeight fails without a finalized result instead of falling back', async () => {
      const operation = 'getBlockAtHeight' as const;

      rpc.getBlock.mockResolvedValue(null);
      await expect(async () => {
        await run(network, operation);
      }).rejects.toThrow(Error);
      expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight returns a settled header
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Request height 10 within matching finalized and canonical history.
     * @expected
     * - The returned header matches the synthetic block fields.
     */
    it('returns a settled header', async () => {
      await expect(network.getBlockAtHeight(10)).resolves.toEqual({
        hash: hash('1'),
        height: 10,
        parentHash: hash('2'),
        timestamp: 100,
        txCount: 2,
      });
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight rejects invalid requested
     * height %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Request each invalid numeric height.
     * @expected
     * - Validation rejects before any block lookup.
     */
    it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
      'rejects invalid requested height %s',
      async (height) => {
        await expect(async () => {
          await network.getBlockAtHeight(height);
        }).rejects.toThrow('requested height');
        expect(rpc.getBlock).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight does not read a height
     * beyond captured settlement
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Request height 21 above the captured frontier of 20.
     * @expected
     * - The request rejects without looking up height 21.
     */
    it('does not read a height beyond captured settlement', async () => {
      await expect(async () => {
        await network.getBlockAtHeight(21);
      }).rejects.toThrow('not settled');
      expect(rpc.getBlock).not.toHaveBeenCalledWith(21);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight rejects an incorrect
     * returned height
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return height 9 for the requested height 10.
     * @expected
     * - Block-number validation rejects.
     */
    it('rejects an incorrect returned height', async () => {
      data.canonical.number = 9;
      await expect(async () => {
        await network.getBlockAtHeight(10);
      }).rejects.toThrow('block number');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight rejects malformed header
     * %s=%s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Replace the selected canonical header field with the table value.
     * @expected
     * - Malformed header validation rejects.
     */
    it.each([
      ['timestamp', -1],
      ['timestamp', 0.5],
      ['parentHash', '0x12'],
      ['length', -1],
    ])('rejects malformed header %s=%s', async (field, value) => {
      Object.assign(data.canonical, { [field]: value });
      await expect(async () => {
        await network.getBlockAtHeight(10);
      }).rejects.toThrow(Error);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockAtHeight rejects a changed finalized
     * identity at the same height
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return a changed finalized hash at the same numeric height.
     * @expected
     * - Canonical identity validation rejects.
     */
    it('rejects a changed finalized identity at the same height', async () => {
      rpc.getBlock
        .mockResolvedValueOnce(data.finalized)
        .mockResolvedValueOnce(data.finalized)
        .mockResolvedValueOnce({ ...data.finalized, hash: hash('f') });
      await expect(async () => {
        await network.getBlockAtHeight(20);
      }).rejects.toThrow('canonical block');
    });
  });

  describe('getBlockTxs', () => {
    /**
     * @target AvalancheRpcNetwork.getBlockTxs getBlockTxs rechecks raw chain
     * identity on each operation
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Run the operation, change eth_chainId, and run it again.
     * @expected
     * - The second call rejects and re-reads raw chain identity.
     */
    it('getBlockTxs rechecks raw chain identity on each operation', async () => {
      const operation = 'getBlockTxs' as const;

      await run(network, operation);
      rpc.send.mockResolvedValue('0xa86a');
      await expect(async () => {
        await run(network, operation);
      }).rejects.toThrow('C-Chain ID');
      expect(rpc.send).toHaveBeenCalledTimes(2);
      expect(rpc.send).toHaveBeenLastCalledWith('eth_chainId', []);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs captures transaction block %s
     * before its canonical lookup
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Mutate the selected transaction-block field during canonical lookup.
     * @expected
     * - The request rejects before querying transaction receipts.
     */
    it.each([
      'number',
      'hash',
      'parentHash',
      'timestamp',
      'transactions',
    ] as const)(
      'captures transaction block %s before its canonical lookup',
      async (field) => {
        rpc.getBlock.mockImplementation(async (tag: string | number) => {
          if (tag === 'finalized' || tag === 20) return data.finalized;
          if (tag === hash('1')) return data.block;
          if (tag === 10) {
            if (field === 'transactions')
              data.block.transactions[0] = hash('6');
            else if (field === 'number') data.block.number = 11;
            else if (field === 'timestamp') data.block.timestamp = 101;
            else data.block[field] = hash('f');
            return data.block;
          }
          return null;
        });
        await expect(async () => {
          await network.getBlockTxs(hash('1'), 10);
        }).rejects.toThrow('canonical block');
        expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheRpcNetwork.getBlockTxs captures transaction %s before
     * receipt waits
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Capture a signed transaction field
     * - mutate it while fetching receipts.
     * @expected
     * - The returned field and signed hash retain the captured values.
     */
    it.each([
      'value',
      'nonce',
      'data',
      'to',
      'gasLimit',
      'chainId',
      'maxFeePerGas',
      'maxPriorityFeePerGas',
    ] as const)(
      'captures transaction %s before receipt waits',
      async (field) => {
        const expected = data.transactions[0][field];
        const mutations = {
          value: 99n,
          nonce: 99,
          data: '0x12',
          to: `0x${'34'.repeat(20)}`,
          gasLimit: 22000n,
          chainId: 43114n,
          maxFeePerGas: 20n,
          maxPriorityFeePerGas: 2n,
        };
        rpc.getTransactionReceipt.mockImplementation(async (id: string) => {
          Object.assign(data.transactions[0], { [field]: mutations[field] });
          return data.receipts.find((receipt) => receipt.hash === id);
        });
        const result = await network.getBlockTxs(hash('1'), 10);
        expect(result[0][field]).toEqual(expected);
        expect(Transaction.from(result[0]).hash).toEqual(data.receipts[0].hash);
      },
    );

    /**
     * @target AvalancheRpcNetwork.getBlockTxs captures every transaction
     * before the first dependent block wait
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Capture both signed bodies
     * - mutate the second during canonical lookup.
     * @expected
     * - Both returned serialized bodies match their captured values.
     */
    it('captures every transaction before the first dependent block wait', async () => {
      const expected = data.transactions.map(
        (tx) => Transaction.from(tx).serialized,
      );
      rpc.getBlock.mockImplementation(async (tag: string | number) => {
        if (tag === 'finalized' || tag === 20) return data.finalized;
        if (tag === hash('1')) return data.block;
        if (tag === 10) {
          Object.assign(data.transactions[1], { value: 99n });
          return data.canonical;
        }
        return null;
      });
      const result = await network.getBlockTxs(hash('1'), 10);
      expect(result.map((tx) => Transaction.from(tx).serialized)).toEqual(
        expected,
      );
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs detaches nested access lists
     * from provider objects before waits
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Add an access-list storage key
     * - mutate it while fetching receipts.
     * @expected
     * - The returned signed body retains the original nested key.
     */
    it('detaches nested access lists from provider objects before waits', async () => {
      const original = Transaction.from(data.transactions[0]);
      original.accessList = [
        { address: `0x${'34'.repeat(20)}`, storageKeys: [hash('5')] },
      ];
      const replacement = {
        ...data.transactions[0],
        hash: original.hash!,
        from: original.from!,
        accessList: original.accessList,
      } as TransactionResponse;
      data.transactions[0] = replacement;
      data.block.transactions[0] = original.hash!;
      data.canonical.transactions[0] = original.hash!;
      data.receipts[0].hash = original.hash!;
      data.receipts[0].from = original.from!;
      const expected = original.serialized;
      rpc.getTransactionReceipt.mockImplementation(async (id: string) => {
        replacement.accessList![0].storageKeys[0] = hash('6');
        return data.receipts.find((receipt) => receipt.hash === id);
      });
      const result = await network.getBlockTxs(hash('1'), 10);
      expect(Transaction.from(result[0]).serialized).toEqual(expected);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs getBlockTxs fails without a
     * finalized result instead of falling back
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return no finalized block and invoke the selected operation.
     * @expected
     * - The operation rejects with no latest-height fallback.
     */
    it('getBlockTxs fails without a finalized result instead of falling back', async () => {
      const operation = 'getBlockTxs' as const;

      rpc.getBlock.mockResolvedValue(null);
      await expect(async () => {
        await run(network, operation);
      }).rejects.toThrow(Error);
      expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs returns complete bound
     * transactions, including failed transactions for downstream filtering
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Mark one receipt failed
     * - read the complete settled block.
     * @expected
     * - Both bound transactions return and both receipts are queried.
     */
    it('returns complete bound transactions, including failed transactions for downstream filtering', async () => {
      data.receipts[1].status = 0;
      await expect(network.getBlockTxs(hash('1'))).resolves.toEqual(
        data.transactions.map((tx) => expect.objectContaining(tx)),
      );
      expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(2);
      expect(rpc.getBlock).toHaveBeenCalledWith(hash('1'), true);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs returns an empty settled block
     * without fabricating transactions
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return the empty finalized block for the requested hash.
     * @expected
     * - The transaction list is empty and no receipts are queried.
     */
    it('returns an empty settled block without fabricating transactions', async () => {
      rpc.getBlock.mockResolvedValue(data.finalized);
      await expect(network.getBlockTxs(hash('3'))).resolves.toEqual([]);
      expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs does not accept an early receipt
     * above settlement
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Place the transaction block above the finalized frontier.
     * @expected
     * - The request rejects without reading receipts.
     */
    it('does not accept an early receipt above settlement', async () => {
      data.finalized.number = 9;
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('not settled');
      expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects a wrong block hash
     * returned for the requested hash
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return a different hash for the requested transaction block.
     * @expected
     * - Block-hash validation rejects.
     */
    it('rejects a wrong block hash returned for the requested hash', async () => {
      rpc.getBlock
        .mockResolvedValueOnce(data.finalized)
        .mockResolvedValueOnce(data.finalized)
        .mockResolvedValueOnce({ ...data.block, hash: hash('f') });
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('block hash');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects a block whose canonical
     * numeric hash disagrees
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Change the numeric canonical block hash.
     * @expected
     * - Canonical identity validation rejects.
     */
    it('rejects a block whose canonical numeric hash disagrees', async () => {
      data.canonical.hash = hash('f');
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('canonical block');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects canonical transaction
     * order disagreement
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Reverse the canonical transaction-hash order.
     * @expected
     * - Canonical transaction-order validation rejects.
     */
    it('rejects canonical transaction order disagreement', async () => {
      data.canonical.transactions.reverse();
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('canonical block');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects duplicate block
     * transaction hashes
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Duplicate one transaction hash in the block.
     * @expected
     * - Duplicate-hash validation rejects.
     */
    it('rejects duplicate block transaction hashes', async () => {
      data.block.transactions[1] = data.block.transactions[0];
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('Duplicate');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects missing prefetched
     * transactions
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Remove the prefetched transactions from a nonempty block.
     * @expected
     * - Missing-prefetched-transaction validation rejects.
     */
    it('rejects missing prefetched transactions', async () => {
      data.block.prefetchedTransactions = [];
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('prefetched');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects prefetched transaction
     * order disagreement
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Reverse the prefetched transaction order.
     * @expected
     * - Transaction identity validation rejects.
     */
    it('rejects prefetched transaction order disagreement', async () => {
      data.block.prefetchedTransactions = [...data.transactions].reverse();
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('transaction identity');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects transaction %s mismatch
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Replace the selected transaction identity field with the table value.
     * @expected
     * - The transaction mismatch rejects.
     */
    it.each([
      ['chainId', 1n],
      ['blockNumber', 9],
      ['index', 1],
      ['blockHash', hash('f')],
      ['blockHash', null],
      ['hash', hash('f')],
      ['hash', '0x12'],
    ])('rejects transaction %s mismatch', async (field, value) => {
      Object.assign(data.transactions[0], { [field]: value });
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow(Error);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs binds signed transaction %s to
     * its hash
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Change one signed-body field without replacing the signed hash.
     * @expected
     * - Signed transaction binding rejects.
     */
    it.each(['value', 'nonce', 'from', 'signature'] as const)(
      'binds signed transaction %s to its hash',
      async (field) => {
        const changes = {
          value: 6n,
          nonce: 7,
          from: `0x${'34'.repeat(20)}`,
          signature: null,
        };
        Object.assign(data.transactions[0], { [field]: changes[field] });
        await expect(async () => {
          await network.getBlockTxs(hash('1'));
        }).rejects.toThrow(Error);
      },
    );

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects receipt %s mismatch
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return a receipt differing in the selected identity or status field.
     * @expected
     * - Receipt validation rejects.
     */
    it.each([
      ['blockNumber', 9],
      ['index', 1],
      ['blockHash', hash('f')],
      ['blockHash', null],
      ['hash', hash('f')],
      ['status', null],
      ['status', 2],
      ['status', '1'],
    ])('rejects receipt %s mismatch', async (field, value) => {
      rpc.getTransactionReceipt.mockResolvedValueOnce({
        ...data.receipts[0],
        [field]: value,
      });
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow(Error);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs fails the whole block if a later
     * receipt is missing
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Return the first receipt and omit the second.
     * @expected
     * - The entire block request rejects.
     */
    it('fails the whole block if a later receipt is missing', async () => {
      rpc.getTransactionReceipt
        .mockResolvedValueOnce(data.receipts[0])
        .mockResolvedValueOnce(null);
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('receipt');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs propagates receipt transport
     * failures
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Reject the receipt request with a transport error.
     * @expected
     * - The receipt transport error propagates.
     */
    it('propagates receipt transport failures', async () => {
      rpc.getTransactionReceipt.mockRejectedValue(new Error('RPC unavailable'));
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow('RPC unavailable');
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs distinguishes contradictions
     * from retryable missing data
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - First contradict the canonical hash, then omit a receipt.
     * @expected
     * - Only the contradiction has the validation-error type.
     */
    it('distinguishes contradictions from retryable missing data', async () => {
      data.canonical.hash = hash('f');
      await expect(async () => {
        await network.getBlockTxs(hash('1'));
      }).rejects.toThrow(AvalancheRpcValidationError);
      data.canonical.hash = hash('1');
      rpc.getTransactionReceipt.mockResolvedValue(null);
      await expect(network.getBlockTxs(hash('1'))).rejects.not.toThrow(
        AvalancheRpcValidationError,
      );
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs binds transactions to the
     * scanner supplied height
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Supply scanner height 10 for the matching block.
     * @expected
     * - The complete matching transaction bodies return.
     */
    it('binds transactions to the scanner supplied height', async () => {
      await expect(network.getBlockTxs(hash('1'), 10)).resolves.toEqual(
        data.transactions.map((tx) => expect.objectContaining(tx)),
      );
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects a scanner height
     * mismatch before reading receipts
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Supply scanner height 11 for the block at height 10.
     * @expected
     * - A validation error occurs before any receipt query.
     */
    it('rejects a scanner height mismatch before reading receipts', async () => {
      await expect(async () => {
        await network.getBlockTxs(hash('1'), 11);
      }).rejects.toThrow(AvalancheRpcValidationError);
      expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs keeps a validated failure
     * reverted when the provider later reports success
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Capture a failed receipt, change the provider status, and call
     * wait(0).
     * @expected
     * - CALL_EXCEPTION retains the failed captured receipt.
     */
    it('keeps a validated failure reverted when the provider later reports success', async () => {
      data.receipts[0].status = 0;
      const [tx] = await network.getBlockTxs(hash('1'), 10);
      data.receipts[0].status = 1;
      rpc.getTransactionReceipt.mockResolvedValue(data.receipts[0]);
      const error = await tx.wait(0).catch((failure: unknown) => failure);
      expect(isCallException(error)).toEqual(true);
      expect(error).toMatchObject({
        code: 'CALL_EXCEPTION',
        receipt: { status: 0, hash: tx.hash, blockHash: hash('1') },
      });
      expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(2);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs returns the same immutable
     * validated receipt after a contradictory provider response
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Capture a successful receipt, contradict the provider, and wait twice.
     * @expected
     * - Both waits return the same frozen captured receipt instance.
     */
    it('returns the same immutable validated receipt after a contradictory provider response', async () => {
      const [tx] = await network.getBlockTxs(hash('1'), 10);
      data.receipts[0].blockHash = hash('f');
      data.receipts[0].blockNumber = 999;
      data.receipts[0].status = 0;
      rpc.getTransactionReceipt.mockResolvedValue(data.receipts[0]);
      const first = await tx.wait(0);
      const second = await tx.wait(0);
      expect(first).toBeInstanceOf(TransactionReceipt);
      expect(first).toBe(second);
      expect(first).toMatchObject({
        status: 1,
        hash: tx.hash,
        blockHash: hash('1'),
        blockNumber: 10,
      });
      expect(Object.isFrozen(first)).toEqual(true);
      expect(first!.logs).toEqual([]);
      expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(2);
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs preserves the signed transaction
     * body and provider metadata
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Read the complete settled block and inspect each returned transaction.
     * @expected
     * - Signed bodies, provider references and block metadata are preserved.
     */
    it('preserves the signed transaction body and provider metadata', async () => {
      const result = await network.getBlockTxs(hash('1'), 10);
      for (const [index, tx] of result.entries()) {
        expect(tx).toBeInstanceOf(TransactionResponse);
        expect(tx.provider).toBe(data.transactions[index].provider);
        expect(Transaction.from(tx).serialized).toEqual(
          Transaction.from(data.transactions[index]).serialized,
        );
        expect(tx).toMatchObject({
          blockHash: hash('1'),
          blockNumber: 10,
          index,
        });
      }
    });

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects unsupported wait depth
     * %s without another receipt query
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Qualify the block, then call wait with each unsupported depth.
     * @expected
     * - Wait rejects without querying another receipt.
     */
    it.each([undefined, -1, 1, 2, 0.5, NaN, Infinity])(
      'rejects unsupported wait depth %s without another receipt query',
      async (confirms) => {
        const [tx] = await network.getBlockTxs(hash('1'), 10);
        await expect(async () => {
          await tx.wait(confirms);
        }).rejects.toThrow('only wait(0)');
        expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(2);
      },
    );

    /**
     * @target AvalancheRpcNetwork.getBlockTxs rejects malformed scanner height
     * %s
     * @dependencies
     * - Mocked ethers JsonRpcProvider methods.
     * - Synthetic signed transactions, canonical blocks and receipts.
     * @scenario
     * - Supply each malformed scanner height.
     * @expected
     * - A validation error occurs before any block or receipt query.
     */
    it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
      'rejects malformed scanner height %s',
      async (height) => {
        await expect(async () => {
          await network.getBlockTxs(hash('1'), height);
        }).rejects.toThrow(AvalancheRpcValidationError);
        expect(rpc.getBlock).not.toHaveBeenCalled();
        expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
      },
    );
  });
});
