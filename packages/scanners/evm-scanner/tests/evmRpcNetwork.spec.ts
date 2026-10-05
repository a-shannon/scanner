import { Transaction } from 'ethers';

import type { EvmRpcNetwork } from '../lib/evmRpcNetwork';
import { BlockNotFound } from '../lib/types';
import {
  mockGetBlockNumber,
  mockGetBlock,
  resetRpcMock,
} from './mocked/jsonRpcProvider.mock';
import { mockRealJsonRpcProvider } from './mocked/realJsonRpcProvider.mock';
import * as testData from './testData';
import { TestEvmRpcNetwork } from './testRpcNetwork';

describe('EvmRpcNetwork', () => {
  let network: TestEvmRpcNetwork;

  beforeEach(() => {
    resetRpcMock();
    network = new TestEvmRpcNetwork('', 1);
  });

  describe('getCurrentHeight', () => {
    /**
     * @target EvmRpcNetwork.getCurrentHeight should return block height
     * successfully
     * @dependencies
     * - Mocked JsonRpcProvider.getBlockNumber and synthetic height fixtures.
     * @scenario
     * - mock `RPC.getBlockNumber`
     * - run test
     * - check returned value
     * @expected
     * - it should be mocked block height
     */
    it('should return block height successfully', async () => {
      // mock client response
      mockGetBlockNumber(network.getProvider(), testData.blockInfo.number);

      // run test
      const result = await network.getCurrentHeight();

      // check returned value
      expect(result).toEqual(testData.blockHeight);
    });
  });

  describe('getBlockTxs', () => {
    /**
     * @target `EvmRpcNetwork.getBlockTxs` should return
     * transactions of the block
     * @dependencies
     * - Mocked JsonRpcProvider.getBlock and synthetic block/transaction fixtures.
     * @scenario
     * - mock `RPC.getBlock` with prefetchTxs `true`
     * - run test
     * - check returned value
     * @expected
     * - it should return transactions of the block
     */
    it('should return transactions of the block', async () => {
      // mock client response
      mockGetBlock(network.getProvider(), testData.blockInfo);

      // run test
      const result = await network.getBlockTxs(testData.blockHash);

      // check returned value
      for (let i = 0; i < result.length; i++) {
        const trx = Transaction.from(result[i]);
        expect(trx.toJSON()).toEqual(testData.convertedTxList[i]);
      }
    });

    /**
     * @target EvmRpcNetwork.getBlockTxs should throw BlockNotFound
     * @dependencies
     * - Mocked JsonRpcProvider.getBlock returning no block.
     * @scenario
     * - mock `RPC.getBlock` with prefetchTxs `true`
     * - run test
     * - call the function and expect error
     * @expected
     * - getBlockTxs should throw BlockNotFound
     */
    it('should throw BlockNotFound', async () => {
      // mock client response
      mockGetBlock(network.getProvider(), null);

      // run test
      await expect(async () => {
        await network.getBlockTxs(testData.blockHash);
      }).rejects.toThrow(BlockNotFound);
    });
  });

  describe('getBlockAtHeight', () => {
    /**
     * @target EvmRpcNetwork.getBlockAtHeight should return block info
     * successfully
     * @dependencies
     * - Mocked JsonRpcProvider.getBlock and synthetic block fixtures.
     * @scenario
     * - mock `RPC.getBlock`
     * - run test
     * - check returned value
     * @expected
     * - it should return block info successfully
     */
    it('should return block info successfully', async () => {
      // mock client response
      mockGetBlock(network.getProvider(), testData.blockInfo);

      // run test
      const result = await network.getBlockAtHeight(testData.blockHeight);

      // check returned value
      expect(result).toEqual({
        hash: testData.blockInfo.hash,
        height: testData.blockInfo.number,
        parentHash: testData.blockInfo.parentHash,
        timestamp: testData.blockInfo.timestamp,
        txCount: testData.blockInfo.length,
      });
    });

    /**
     * @target `EvmRpcNetwork.getBlockAtHeight` should throw
     * error when block height is wrong
     * @dependencies
     * - Mocked JsonRpcProvider.getBlock returning no block.
     * @scenario
     * - mock `RPC.getBlock`
     * - run test
     * - call the function and expect error
     * @expected
     * - getBlockAtHeight should throw BlockNotFound
     */
    it('should throw error when block height is wrong', async () => {
      // mock client response
      mockGetBlock(network.getProvider(), null);

      // run test
      await expect(async () => {
        await network.getBlockAtHeight(testData.wrongBlockHeight);
      }).rejects.toThrow(BlockNotFound);
    });
  });
  describe('constructor', () => {
    const networks: EvmRpcNetwork[] = [];

    afterEach(() => {
      networks.splice(0).forEach((network) => network['provider'].destroy());
    });

    let restoreProvider: () => void;
    beforeEach(async () => {
      restoreProvider = await mockRealJsonRpcProvider();
    });
    afterEach(() => restoreProvider());

    /**
     * @target EvmRpcNetwork.constructor installs the configured timeout before
     * provider cloning (%s)
     * @dependencies
     * - EVM JSON-RPC provider with synthetic endpoint configuration.
     * @scenario
     * - Configure a timeout with and without a synthetic auth token
     * - mutate a cloned request.
     * @expected
     * - The URL is correct and the provider retains its original timeout.
     */
    it.each([undefined, 'synthetic-token'])(
      'installs the configured timeout before provider cloning (%s)',
      (authToken) => {
        const url = 'http://127.0.0.1:1/ext/bc/C/rpc';
        const network = new TestEvmRpcNetwork(url, 8000, authToken);
        networks.push(network);
        const connection = network['provider']._getConnection();
        expect(connection.timeout).toEqual(8000);
        expect(connection.url).toEqual(authToken ? `${url}/${authToken}` : url);
        connection.timeout = 1;
        expect(network['provider']._getConnection().timeout).toEqual(8000);
      },
    );

    /**
     * @target EvmRpcNetwork.constructor retains the provider default when no
     * timeout is supplied
     * @dependencies
     * - EVM JSON-RPC provider with synthetic endpoint configuration.
     * @scenario
     * - Construct the generic EVM adapter without an explicit timeout.
     * @expected
     * - The provider retains its 300000 millisecond default.
     */
    it('retains the provider default when no timeout is supplied', () => {
      const network = new TestEvmRpcNetwork('http://127.0.0.1:1');
      networks.push(network);
      expect(network['provider']._getConnection().timeout).toEqual(300000);
    });
  });
});
