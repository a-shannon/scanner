import { TransactionReceipt } from 'ethers';

import { DummyLogger } from '@rosen-bridge/abstract-logger';
import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import { chainValidators, chainDecoders } from '@rosen-bridge/address-codec';
import { AddressManager } from '@rosen-bridge/address-manager';
import {
  AvalancheRpcObservationExtractor,
  BinanceRpcObservationExtractor,
  EthereumRpcObservationExtractor,
} from '@rosen-bridge/evm-observation-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { RawDataProviderStateEntity } from '../../../lib/entities';
import { EvmRawDataProvider } from '../../../lib/providers/evm/evmRawDataProvider';
import { createDatabase } from '../../utils';
import {
  lockAddress,
  blockHash,
  rawData,
  connection,
} from './evmRawDataProviderTestData';
import {
  createTokenMap,
  createTransaction,
} from './evmRawDataProviderTestUtils';
import { mockSuccessfulReceipt } from './mocked/evmRawDataProvider.mock';

describe('EvmRawDataProvider', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    AddressManager.init(chainValidators, chainDecoders);
    dataSource = await createDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataSource.destroy();
  });

  describe('constructor', () => {
    /**
     * @target EvmRawDataProvider.constructor selects the chain and filter for
     * %s
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Construct each supported extractor and fetch its chain state and empty
     * replay batch.
     * @expected
     * - The chain and observation filter match the configured extractor.
     */
    it.each([
      [EthereumRpcObservationExtractor, 'ethereum', 'ethereum-rpc-extractor'],
      [BinanceRpcObservationExtractor, 'binance', 'binance-rpc-extractor'],
      [
        AvalancheRpcObservationExtractor,
        'avalanche',
        'avalanche-rpc-extractor',
      ],
    ])('selects the chain and filter for %s', async (Extractor, chain, id) => {
      const extractor = new Extractor(
        lockAddress,
        dataSource,
        await createTokenMap(),
      );
      const provider = new EvmRawDataProvider(
        dataSource,
        extractor,
        connection,
        new DummyLogger(),
      );
      const fetch = vi.spyOn(provider['action'], 'fetchChainObservations');
      const state = await provider['fetchOrCreateStateForChain']();
      expect(state.chain).toEqual(chain);
      await expect(async () => {
        await provider['fillObservationsRawData'](state);
      }).rejects.toThrow('No more observations found');
      expect(fetch).toHaveBeenCalledWith(chain, 0, id);
      provider['client'].destroy();
    });

    /**
     * @target EvmRawDataProvider.constructor rejects an unknown extractor
     * instead of assigning Binance
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Construct the provider with an unknown extractor identity.
     * @expected
     * - Unsupported extractor validation rejects.
     */
    it('rejects an unknown extractor instead of assigning Binance', () => {
      const unknown = {
        FROM_CHAIN: 'ethereum',
        getId: () => 'unknown-extractor',
      } as unknown as EthereumRpcObservationExtractor;
      expect(
        () =>
          new EvmRawDataProvider(
            dataSource,
            unknown,
            connection,
            new DummyLogger(),
          ),
      ).toThrow('Unsupported EVM observation extractor');
    });
  });

  describe('fillRawData', () => {
    /**
     * @target EvmRawDataProvider.fillRawData replays only Avalanche
     * observations with the matching extractor identity
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Store Avalanche and foreign observations, then replay the matching
     * block.
     * @expected
     * - Only the selected Avalanche extractor row and its cursor are repaired.
     */
    it('replays only Avalanche observations with the matching extractor identity', async () => {
      const extractor = new AvalancheRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap('avalanche', 'avax'),
      );
      const tx = createTransaction(10, 43114n);
      mockSuccessfulReceipt(tx);
      await extractor.processTransactions([tx], {
        height: 10,
        hash: blockHash,
      });
      const repository = dataSource.getRepository(ObservationEntity);
      const [original] = await repository.find();
      await repository.update(original.id, { rawData: '' });
      await repository.insert([
        {
          ...original,
          id: undefined,
          fromChain: 'binance',
          extractor: 'binance-rpc-extractor',
          rawData: '',
        },
        {
          ...original,
          id: undefined,
          extractor: 'other-avalanche-extractor',
          rawData: '',
        },
      ]);
      const provider = new EvmRawDataProvider(
        dataSource,
        extractor,
        connection,
        new DummyLogger(),
      );
      const getBlock = vi
        .spyOn(provider['client'], 'getBlock')
        .mockResolvedValue({
          hash: blockHash,
          number: 10,
          prefetchedTransactions: [tx],
        } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
      await provider.fillRawData();
      expect(getBlock).toHaveBeenCalledExactlyOnceWith(10, true);
      expect(
        await repository.findOneByOrFail({ id: original.id }),
      ).toMatchObject({
        fromChain: 'avalanche',
        extractor: 'avalanche-rpc-extractor',
        rawData,
        sourceTxId: tx.hash,
        sourceChainTokenId: 'avax',
      });
      const rows = await repository.find();
      expect(
        rows.filter((row) => row.id !== original.id).map((row) => row.rawData),
      ).toEqual(['', '']);
      expect(
        await dataSource.getRepository(RawDataProviderStateEntity).find(),
      ).toEqual([
        expect.objectContaining({ chain: 'avalanche', syncedHeight: 10 }),
      ]);
      provider['client'].destroy();
    });

    /**
     * @target EvmRawDataProvider.fillRawData repairs an exact stored
     * observation for %s
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Remove raw data from the selected chain row
     * - replay its transaction with an unrelated one.
     * @expected
     * - Only the exact stored observation is restored and the cursor reaches
     * 10.
     */
    it.each([
      [EthereumRpcObservationExtractor, 'ethereum', 'eth', 1n],
      [BinanceRpcObservationExtractor, 'binance', 'bnb', 56n],
      [AvalancheRpcObservationExtractor, 'avalanche', 'avax', 43114n],
    ])(
      'repairs an exact stored observation for %s',
      async (Extractor, chain, native, chainId) => {
        const extractor = new Extractor(
          lockAddress,
          dataSource,
          await createTokenMap(chain, native),
        );
        const tx = createTransaction(10, chainId);
        mockSuccessfulReceipt(tx);
        await extractor.processTransactions([tx], {
          height: 10,
          hash: blockHash,
        });
        const repository = dataSource.getRepository(ObservationEntity);
        const [original] = await repository.find();
        await repository.update(original.id, { rawData: '' });
        const provider = new EvmRawDataProvider(
          dataSource,
          extractor,
          connection,
          new DummyLogger(),
        );
        const unrelated = createTransaction(11, chainId);
        const unrelatedWait = vi.spyOn(unrelated, 'wait');
        vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
          hash: blockHash,
          number: 10,
          prefetchedTransactions: [tx, unrelated],
        } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
        await provider.fillRawData();
        expect(await repository.find()).toEqual([original]);
        expect(unrelatedWait).not.toHaveBeenCalled();
        expect(
          await dataSource
            .getRepository(RawDataProviderStateEntity)
            .findOneByOrFail({ chain }),
        ).toMatchObject({ syncedHeight: 10 });
        provider['client'].destroy();
      },
    );

    /**
     * @target EvmRawDataProvider.fillRawData rejects %s before extraction and
     * leaves storage and cursor unchanged
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Alter the selected block or transaction identity before replay.
     * @expected
     * - Extraction is skipped and both stored rows and cursor remain
     * unchanged.
     */
    it.each([
      'missing block',
      'wrong block hash',
      'wrong block height',
      'wrong stored source block',
      'empty transactions',
      'wrong transaction',
      'duplicate transaction',
      'wrong transaction block hash',
      'wrong transaction block height',
    ])(
      'rejects %s before extraction and leaves storage and cursor unchanged',
      async (failure) => {
        const extractor = new EthereumRpcObservationExtractor(
          lockAddress,
          dataSource,
          await createTokenMap(),
        );
        const tx = createTransaction();
        mockSuccessfulReceipt(tx);
        await extractor.processTransactions([tx], {
          height: 10,
          hash: blockHash,
        });
        const repository = dataSource.getRepository(ObservationEntity);
        const [row] = await repository.find();
        await repository.update(row.id, {
          rawData: '',
          ...(failure === 'wrong stored source block'
            ? { sourceBlockId: '0x' + 'bb'.repeat(32) }
            : {}),
        });
        const before = await repository.find();
        const provider = new EvmRawDataProvider(
          dataSource,
          extractor,
          connection,
          new DummyLogger(),
        );
        const process = vi.spyOn(extractor, 'extractObservations');
        if (failure === 'wrong transaction block hash')
          Object.defineProperty(tx, 'blockHash', {
            value: '0x' + 'bb'.repeat(32),
          });
        if (failure === 'wrong transaction block height')
          Object.defineProperty(tx, 'blockNumber', { value: 11 });
        const response = {
          hash:
            failure === 'wrong block hash' ? '0x' + 'bb'.repeat(32) : blockHash,
          number: failure === 'wrong block height' ? 11 : 10,
          prefetchedTransactions:
            failure === 'empty transactions'
              ? []
              : failure === 'wrong transaction'
                ? [createTransaction(11)]
                : failure === 'duplicate transaction'
                  ? [tx, tx]
                  : [tx],
        };
        vi.spyOn(provider['client'], 'getBlock').mockResolvedValue(
          (failure === 'missing block' ? null : response) as Awaited<
            ReturnType<(typeof provider)['client']['getBlock']>
          >,
        );
        await provider.fillRawData();
        expect(process).not.toHaveBeenCalled();
        expect(await repository.find()).toEqual(before);
        expect(
          await dataSource
            .getRepository(RawDataProviderStateEntity)
            .findOneByOrFail({ chain: 'ethereum' }),
        ).toMatchObject({ syncedHeight: 0 });
        provider['client'].destroy();
      },
    );

    /**
     * @target EvmRawDataProvider.fillRawData does not commit replay when %s
     * produces no usable repair
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Remove stored raw data, then provide a failed or ineligible extraction
     * result.
     * @expected
     * - One unrepaired row remains and the cursor stays at zero.
     */
    it.each([
      'no eligible transaction',
      'failed receipt',
      'raw extraction disabled',
    ])(
      'does not commit replay when %s produces no usable repair',
      async (failure) => {
        const tokens = await createTokenMap();
        const extractor = new EthereumRpcObservationExtractor(
          lockAddress,
          dataSource,
          tokens,
        );
        const tx = createTransaction();
        const wait = vi
          .spyOn(tx, 'wait')
          .mockResolvedValue({} as TransactionReceipt);
        await extractor.processTransactions([tx], {
          height: 10,
          hash: blockHash,
        });
        const repository = dataSource.getRepository(ObservationEntity);
        const [original] = await repository.find();
        await repository.update(original.id, { rawData: '' });
        if (failure === 'failed receipt')
          wait.mockRejectedValue({ code: 'CALL_EXCEPTION' });
        const replay = new EthereumRpcObservationExtractor(
          failure === 'no eligible transaction'
            ? '0x' + '22'.repeat(20)
            : lockAddress,
          dataSource,
          tokens,
          undefined,
          failure !== 'raw extraction disabled',
        );
        const provider = new EvmRawDataProvider(
          dataSource,
          replay,
          connection,
          new DummyLogger(),
        );
        vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
          hash: blockHash,
          number: 10,
          prefetchedTransactions: [tx],
        } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
        await provider.fillRawData();
        expect(await repository.count()).toEqual(1);
        expect(
          (await repository.findOneByOrFail({ id: original.id })).rawData,
        ).toEqual('');
        expect(
          await dataSource
            .getRepository(RawDataProviderStateEntity)
            .findOneByOrFail({ chain: 'ethereum' }),
        ).toMatchObject({ syncedHeight: 0 });
        provider['client'].destroy();
      },
    );

    /**
     * @target EvmRawDataProvider.fillRawData repairs every same-height row
     * after a later row fails and the provider restarts
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Create eleven same-height rows, fail the last receipt, then restart
     * replay.
     * @expected
     * - The first pass holds the cursor; the restart restores every original
     * row.
     */
    it('repairs every same-height row after a later row fails and the provider restarts', async () => {
      const extractor = new EthereumRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap(),
      );
      const txs = Array.from({ length: 11 }, (_, i) =>
        createTransaction(i + 10),
      );
      for (const tx of txs) mockSuccessfulReceipt(tx);
      await extractor.processTransactions(txs, { height: 10, hash: blockHash });
      const repository = dataSource.getRepository(ObservationEntity);
      const originals = await repository.find();
      for (const row of originals)
        await repository.update(row.id, { rawData: '' });
      const provider = new EvmRawDataProvider(
        dataSource,
        extractor,
        connection,
        new DummyLogger(),
      );
      vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
        hash: blockHash,
        number: 10,
        prefetchedTransactions: txs,
      } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
      vi.mocked(txs[10].wait).mockRejectedValueOnce(
        new Error('receipt RPC unavailable'),
      );
      await provider.fillRawData();
      expect(await repository.countBy({ rawData: '' })).toEqual(1);
      expect(
        await dataSource
          .getRepository(RawDataProviderStateEntity)
          .findOneByOrFail({ chain: 'ethereum' }),
      ).toMatchObject({ syncedHeight: 0 });
      provider['client'].destroy();
      const restarted = new EvmRawDataProvider(
        dataSource,
        extractor,
        connection,
        new DummyLogger(),
      );
      vi.spyOn(restarted['client'], 'getBlock').mockResolvedValue({
        hash: blockHash,
        number: 10,
        prefetchedTransactions: txs,
      } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
      await restarted.fillRawData();
      expect(await repository.find()).toEqual(originals);
      expect(
        await dataSource
          .getRepository(RawDataProviderStateEntity)
          .findOneByOrFail({ chain: 'ethereum' }),
      ).toMatchObject({ syncedHeight: 10 });
      restarted['client'].destroy();
    });

    /**
     * @target EvmRawDataProvider.fillRawData does not adopt a mismatched
     * persisted amount on the next fill attempt
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Change a persisted amount, then run the same fill attempt twice.
     * @expected
     * - The mismatched amount is preserved and the cursor never advances.
     */
    it('does not adopt a mismatched persisted amount on the next fill attempt', async () => {
      const extractor = new EthereumRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap(),
      );
      const tx = createTransaction();
      mockSuccessfulReceipt(tx);
      await extractor.processTransactions([tx], {
        height: 10,
        hash: blockHash,
      });
      const repository = dataSource.getRepository(ObservationEntity);
      const [original] = await repository.find();
      await repository.update(original.id, { amount: '42', rawData: '' });
      const before = await repository.find();
      const provider = new EvmRawDataProvider(
        dataSource,
        extractor,
        connection,
        new DummyLogger(),
      );
      vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
        hash: blockHash,
        number: 10,
        prefetchedTransactions: [tx],
      } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
      await provider.fillRawData();
      await provider.fillRawData();
      expect(await repository.find()).toEqual(before);
      expect(
        await dataSource
          .getRepository(RawDataProviderStateEntity)
          .findOneByOrFail({ chain: 'ethereum' }),
      ).toMatchObject({ syncedHeight: 0 });
      provider['client'].destroy();
    });
  });

  describe('processObservation', () => {
    /**
     * @target EvmRawDataProvider.processObservation rejects a different stored
     * %s before writing, including repeated replay
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Change one persisted observation field and attempt the replay twice.
     * @expected
     * - Both attempts reject without ingestion or update and preserve the
     * changed row.
     */
    it.each([
      'amount',
      'bridgeFee',
      'networkFee',
      'fromAddress',
      'toAddress',
      'fromChain',
      'toChain',
      'sourceChainTokenId',
      'targetChainTokenId',
      'sourceTxId',
      'sourceBlockId',
      'requestId',
      'extractor',
      'block',
      'height',
    ] as const)(
      'rejects a different stored %s before writing, including repeated replay',
      async (field) => {
        const extractor = new EthereumRpcObservationExtractor(
          lockAddress,
          dataSource,
          await createTokenMap(),
        );
        const tx = createTransaction();
        mockSuccessfulReceipt(tx);
        await extractor.processTransactions([tx], {
          height: 10,
          hash: blockHash,
        });
        const repository = dataSource.getRepository(ObservationEntity);
        const [original] = await repository.find();
        await repository.update(original.id, {
          rawData: '',
          [field]: field === 'height' ? 11 : 'different',
        });
        const before = await repository.find();
        const provider = new EvmRawDataProvider(
          dataSource,
          extractor,
          connection,
          new DummyLogger(),
        );
        vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
          hash: blockHash,
          number: 10,
          prefetchedTransactions: [tx],
        } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
        const ingest = vi.spyOn(extractor, 'processTransactions');
        const update = vi.spyOn(repository, 'update');
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(
            await provider['processObservation'](
              await repository.findOneByOrFail({ id: original.id }),
            ),
          ).toEqual(false);
          expect(await repository.find()).toEqual(before);
        }
        expect(ingest).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        provider['client'].destroy();
      },
    );

    /**
     * @target EvmRawDataProvider.processObservation fails the conditional
     * update after a concurrent %s change
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Change or delete the row between derivation and conditional update.
     * @expected
     * - Repair reports false and preserves the concurrent row state.
     */
    it.each(['amount', 'rawData', 'deleted row'])(
      'fails the conditional update after a concurrent %s change',
      async (field) => {
        const extractor = new EthereumRpcObservationExtractor(
          lockAddress,
          dataSource,
          await createTokenMap(),
        );
        const tx = createTransaction();
        mockSuccessfulReceipt(tx);
        await extractor.processTransactions([tx], {
          height: 10,
          hash: blockHash,
        });
        const repository = dataSource.getRepository(ObservationEntity);
        const [original] = await repository.find();
        await repository.update(original.id, { rawData: '' });
        const observation = await repository.findOneByOrFail({
          id: original.id,
        });
        const derive = extractor.extractObservations.bind(extractor);
        vi.spyOn(extractor, 'extractObservations').mockImplementation(
          async (...args) => {
            const derived = await derive(...args);
            if (field === 'deleted row') await repository.delete(original.id);
            else
              await repository.update(original.id, { [field]: 'concurrent' });
            return derived;
          },
        );
        const provider = new EvmRawDataProvider(
          dataSource,
          extractor,
          connection,
          new DummyLogger(),
        );
        vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
          hash: blockHash,
          number: 10,
          prefetchedTransactions: [tx],
        } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
        expect(await provider['processObservation'](observation)).toEqual(
          false,
        );
        if (field === 'deleted row')
          expect(await repository.count()).toEqual(0);
        else
          expect(await repository.findOneByOrFail({ id: original.id })).toEqual(
            {
              ...observation,
              [field]: 'concurrent',
            },
          );
        provider['client'].destroy();
      },
    );

    /**
     * @target EvmRawDataProvider.processObservation rejects %s without
     * reporting repair success
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Return duplicate candidates or change the row after the conditional
     * write.
     * @expected
     * - Repair reports false and preserves the observed post-write row state.
     */
    it.each(['multiple candidates', 'changed after write'])(
      'rejects %s without reporting repair success',
      async (failure) => {
        const extractor = new EthereumRpcObservationExtractor(
          lockAddress,
          dataSource,
          await createTokenMap(),
        );
        const tx = createTransaction();
        mockSuccessfulReceipt(tx);
        await extractor.processTransactions([tx], {
          height: 10,
          hash: blockHash,
        });
        const repository = dataSource.getRepository(ObservationEntity);
        const [original] = await repository.find();
        await repository.update(original.id, { rawData: '' });
        const observation = await repository.findOneByOrFail({
          id: original.id,
        });
        if (failure === 'multiple candidates') {
          const derive = extractor.extractObservations.bind(extractor);
          vi.spyOn(extractor, 'extractObservations').mockImplementation(
            async (...args) => {
              const result = await derive(...args);
              return [...result, ...result];
            },
          );
        } else {
          const update = repository.update.bind(repository);
          vi.spyOn(repository, 'update').mockImplementation(
            async (criteria, partial) => {
              const result = await update(criteria, partial);
              await update(original.id, { rawData: 'concurrent' });
              return result;
            },
          );
        }
        const provider = new EvmRawDataProvider(
          dataSource,
          extractor,
          connection,
          new DummyLogger(),
        );
        vi.spyOn(provider['client'], 'getBlock').mockResolvedValue({
          hash: blockHash,
          number: 10,
          prefetchedTransactions: [tx],
        } as Awaited<ReturnType<(typeof provider)['client']['getBlock']>>);
        expect(await provider['processObservation'](observation)).toEqual(
          false,
        );
        expect(await repository.find()).toEqual([
          {
            ...observation,
            rawData: failure === 'multiple candidates' ? '' : 'concurrent',
          },
        ]);
        provider['client'].destroy();
      },
    );
  });

  describe('fetchObservationTxs', () => {
    /**
     * @target EvmRawDataProvider.fetchObservationTxs reports Ethereum RPC
     * errors without changing chain identity
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - Real EVM observation extractor, synthetic token map and RPC method
     * spies.
     * @scenario
     * - Reject the provider block lookup with a transport error.
     * @expected
     * - The error retains the Ethereum chain label.
     */
    it('reports Ethereum RPC errors without changing chain identity', async () => {
      const extractor = new EthereumRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap(),
      );
      const provider = new EvmRawDataProvider(
        dataSource,
        extractor,
        connection,
        new DummyLogger(),
      );
      vi.spyOn(provider['client'], 'getBlock').mockRejectedValue(
        new Error('RPC unavailable'),
      );
      await expect(async () => {
        await provider['fetchObservationTxs']({
          height: 10,
          sourceTxId: 'tx',
        } as ObservationEntity);
      }).rejects.toThrow('for [ethereum] chain failed: Error: RPC unavailable');
      provider['client'].destroy();
    });
  });
});
