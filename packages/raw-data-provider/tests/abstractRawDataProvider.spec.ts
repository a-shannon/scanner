import {
  AbstractObservationExtractor,
  ObservationEntity,
} from '@rosen-bridge/abstract-observation-extractor';
import { DataSource, Repository } from '@rosen-bridge/extended-typeorm';

import { RawDataProviderStateEntity } from '../lib/entities';
import { insertObservation } from './abstractRawDataProviderTestUtils';
import { createMockObservationExtractor } from './mocked/abstractObservationExtractor.mock';
import { TestRawDataProvider } from './testRawDataProvider';
import { createDatabase } from './utils';

describe('AbstractRawDataProvider', () => {
  let dataSource: DataSource;

  let repository: Repository<ObservationEntity>;

  let extractor: AbstractObservationExtractor<ObservationEntity>;

  let provider: TestRawDataProvider;

  beforeEach(async () => {
    dataSource = await createDatabase();
    repository = dataSource.getRepository(ObservationEntity);
    extractor = createMockObservationExtractor(repository);
    provider = new TestRawDataProvider('ergo', dataSource, extractor);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataSource.destroy();
  });

  describe('fetchOrCreateStateForChain', () => {
    /**
     * @target AbstractRawDataProvider.fetchOrCreateStateForChain creates state
     * using the latest observation height
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Insert observations at heights 10 and 20, then fetch the chain state.
     * @expected
     * - A new state uses lastHeight 20 and syncedHeight zero.
     */
    it('creates state using the latest observation height', async () => {
      await insertObservation(repository, 10, 'first');
      await insertObservation(repository, 20, 'second');
      expect(await provider['fetchOrCreateStateForChain']()).toEqual({
        chain: 'ergo',
        lastHeight: 20,
        syncedHeight: 0,
      });
    });

    /**
     * @target AbstractRawDataProvider.fetchOrCreateStateForChain returns
     * existing state
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Store a state with syncedHeight 10, then fetch it.
     * @expected
     * - The existing state returns unchanged.
     */
    it('returns existing state', async () => {
      const state = { chain: 'ergo', lastHeight: 20, syncedHeight: 10 };
      await dataSource.getRepository(RawDataProviderStateEntity).save(state);
      expect(await provider['fetchOrCreateStateForChain']()).toEqual(state);
    });
  });

  describe('fillObservationsRawData', () => {
    /**
     * @target AbstractRawDataProvider.fillObservationsRawData waits for
     * extraction and stored repair before advancing the cursor
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Pause extraction, inspect the cursor, persist the repaired row, then
     * finish extraction.
     * @expected
     * - The cursor advances only after extraction and stored repair complete.
     */
    it('waits for extraction and stored repair before advancing the cursor', async () => {
      const observation = await insertObservation(repository);
      const state = await provider['fetchOrCreateStateForChain']();
      let complete!: (success: boolean) => void;
      const pending = new Promise<boolean>((resolve) => {
        complete = resolve;
      });
      const process = vi
        .spyOn(extractor, 'processTransactions')
        .mockReturnValue(pending);
      const store = vi.spyOn(provider['action'], 'store');
      const filling = provider['fillObservationsRawData'](state);
      await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
      expect(state.syncedHeight).toEqual(0);
      expect(store).not.toHaveBeenCalled();
      await repository.update(observation.id, { rawData: 'replayed' });
      complete(true);
      await filling;
      expect(state.syncedHeight).toEqual(10);
      expect(store).toHaveBeenCalledExactlyOnceWith({
        chain: 'ergo',
        lastHeight: 10,
        syncedHeight: 10,
      });
    });

    /**
     * @target AbstractRawDataProvider.fillObservationsRawData does not advance
     * after extraction %s
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Return false, reject asynchronously or throw during extraction.
     * @expected
     * - Both memory and persisted cursors remain at zero.
     */
    it.each(['false result', 'async rejection', 'synchronous exception'])(
      'does not advance after extraction %s',
      async (failure) => {
        await insertObservation(repository);
        const state = await provider['fetchOrCreateStateForChain']();
        const process = vi.spyOn(extractor, 'processTransactions');
        if (failure === 'false result') process.mockResolvedValue(false);
        else if (failure === 'async rejection')
          process.mockRejectedValue(new Error('storage failed'));
        else
          process.mockImplementation(() => {
            throw new Error('extraction failed');
          });
        await expect(async () => {
          await provider['fillObservationsRawData'](state);
        }).rejects.toThrow('failed to process observation');
        expect(state.syncedHeight).toEqual(0);
        expect(await provider['action'].fetchByChain('ergo')).toMatchObject({
          syncedHeight: 0,
        });
      },
    );

    /**
     * @target AbstractRawDataProvider.fillObservationsRawData does not mutate
     * the in-memory cursor when persisting the group cursor fails
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Repair the row but reject persistence of the grouped cursor.
     * @expected
     * - The persistence error propagates and the in-memory cursor stays at
     * zero.
     */
    it('does not mutate the in-memory cursor when persisting the group cursor fails', async () => {
      await insertObservation(repository);
      const state = await provider['fetchOrCreateStateForChain']();
      vi.spyOn(provider['action'], 'store').mockRejectedValue(
        new Error('DB failed'),
      );
      await expect(async () => {
        await provider['fillObservationsRawData'](state);
      }).rejects.toThrow('DB failed');
      expect(state.syncedHeight).toEqual(0);
    });
  });

  describe('processObservation', () => {
    /**
     * @target AbstractRawDataProvider.processObservation rejects a successful
     * extractor with %s persisted output
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Report extraction success while altering or omitting the selected
     * stored output.
     * @expected
     * - The unusable persisted repair returns false.
     */
    it.each([
      'empty',
      'disabled',
      'different row',
      'changed identity',
      'changed payload',
      'deleted row',
    ])(
      'rejects a successful extractor with %s persisted output',
      async (result) => {
        const observation = await insertObservation(repository);
        const unrelated = await insertObservation(repository, 10, 'unrelated');
        vi.spyOn(extractor, 'processTransactions').mockImplementation(
          async () => {
            if (result === 'disabled')
              await repository.update(observation.id, {
                rawData: 'raw-data extraction is off',
              });
            if (result === 'different row')
              await repository.update(unrelated.id, { rawData: 'replayed' });
            if (result === 'changed identity')
              await repository.update(observation.id, {
                rawData: 'replayed',
                sourceTxId: 'different-tx',
              });
            if (result === 'changed payload')
              await repository.update(observation.id, {
                rawData: 'replayed',
                amount: '1',
              });
            if (result === 'deleted row')
              await repository.delete(observation.id);
            return true;
          },
        );
        expect(await provider['processObservation'](observation)).toEqual(
          false,
        );
      },
    );

    /**
     * @target AbstractRawDataProvider.processObservation rejects %s before
     * extraction
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Return empty or absent transactions, or reject transaction fetching.
     * @expected
     * - Processing returns false without invoking extraction.
     */
    it.each(['empty transactions', 'missing transactions', 'fetch rejection'])(
      'rejects %s before extraction',
      async (failure) => {
        const observation = await insertObservation(repository);
        const fetch = vi.spyOn(provider, 'fetchObservationTxs');
        if (failure === 'fetch rejection')
          fetch.mockRejectedValue(new Error('RPC failed'));
        else
          fetch.mockResolvedValue(
            failure === 'empty transactions' ? [] : undefined,
          );
        expect(await provider['processObservation'](observation)).toEqual(
          false,
        );
        expect(extractor.processTransactions).not.toHaveBeenCalled();
      },
    );
  });

  describe('fillRawData', () => {
    /**
     * @target AbstractRawDataProvider.fillRawData repairs only the selected
     * chain and extractor, including more than one batch at a height
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Insert multiple same-height batches plus foreign-chain and
     * foreign-extractor rows.
     * @expected
     * - Only twelve matching rows repair and grouped cursors advance to 10
     * then 20.
     */
    it('repairs only the selected chain and extractor, including more than one batch at a height', async () => {
      for (let i = 0; i < 11; i++)
        await insertObservation(repository, 10, 'row-' + i);
      await insertObservation(repository, 20, 'later');
      const foreign = await insertObservation(repository, 10, 'foreign');
      await repository.update(foreign.id, { fromChain: 'cardano' });
      const other = await insertObservation(repository, 10, 'other-extractor');
      await repository.update(other.id, { extractor: 'other' });
      const store = vi.spyOn(provider['action'], 'store');
      await provider.fillRawData();
      expect(await repository.countBy({ rawData: 'replayed' })).toEqual(12);
      expect(await repository.countBy({ rawData: '' })).toEqual(2);
      expect(await provider['action'].fetchByChain('ergo')).toMatchObject({
        syncedHeight: 20,
      });
      expect(store).toHaveBeenCalledTimes(3);
      expect(
        store.mock.calls.slice(1).map(([state]) => state.syncedHeight),
      ).toEqual([10, 20]);
    });

    /**
     * @target AbstractRawDataProvider.fillRawData retries the complete
     * same-height group after partial failure and restart
     * @dependencies
     * - SQLite observation and raw-data state repositories.
     * - TestRawDataProvider and mocked observation extraction.
     * @scenario
     * - Repair the first same-height row, fail the second, then restart the
     * provider.
     * @expected
     * - The failed pass holds its cursor and restart repairs the entire height
     * group.
     */
    it('retries the complete same-height group after partial failure and restart', async () => {
      const first = await insertObservation(repository, 10, 'first');
      const second = await insertObservation(repository, 10, 'second');
      const process = vi.spyOn(extractor, 'processTransactions');
      process.mockImplementationOnce(async () => {
        await repository.update(first.id, { rawData: 'replayed' });
        return true;
      });
      process.mockResolvedValueOnce(false);
      await provider.fillRawData();
      expect(await provider['action'].fetchByChain('ergo')).toMatchObject({
        syncedHeight: 0,
      });
      expect(await repository.findOneByOrFail({ id: second.id })).toMatchObject(
        {
          rawData: '',
        },
      );
      const restarted = new TestRawDataProvider('ergo', dataSource, extractor);
      await restarted.fillRawData();
      expect(await repository.countBy({ rawData: 'replayed' })).toEqual(2);
      expect(await provider['action'].fetchByChain('ergo')).toMatchObject({
        syncedHeight: 10,
      });
      expect(process).toHaveBeenCalledTimes(4);
    });
  });
});
