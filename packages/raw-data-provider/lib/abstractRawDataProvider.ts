import { AbstractLogger, DummyLogger } from '@rosen-bridge/abstract-logger';
import {
  AbstractObservationExtractor,
  ObservationEntity,
} from '@rosen-bridge/abstract-observation-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';

import { RawDataProviderStateEntityAction } from './actions/rawDataProviderStateEntityAction';
import { RawDataProviderStateEntity } from './entities';

export abstract class AbstractRawDataProvider<TxType> {
  protected action: RawDataProviderStateEntityAction;

  /**
   * Creates the state action used to repair observations for one chain.
   * @param chain - Chain whose observations are replayed.
   * @param dataSource - Database containing observation and provider state.
   * @param extractor - Extractor used to replay stored observations.
   * @param logger - Provider logger; defaults to DummyLogger.
   */
  constructor(
    protected chain: string,
    protected dataSource: DataSource,
    protected extractor: AbstractObservationExtractor<TxType>,
    protected logger: AbstractLogger = new DummyLogger(),
  ) {
    this.action = new RawDataProviderStateEntityAction(
      dataSource,
      logger.child('RawDataProviderStateEntityAction'),
    );
  }

  /**
   * Retrieves the current RawDataProviderStateEntity for the configured chain.
   *
   * @returns The existing or newly created RawDataProviderStateEntity
   */
  protected fetchOrCreateStateForChain =
    async (): Promise<RawDataProviderStateEntity> => {
      let state = await this.action.fetchByChain(this.chain);
      if (!state) {
        const latestChainObservation =
          await this.action.fetchLatestObservationByChain(this.chain);
        let lastHeight = 0;
        if (!latestChainObservation) {
          this.logger.warn(
            `Not find any ObservationEntity for the ${this.chain} chain`,
          );
        } else {
          lastHeight = latestChainObservation.height;
        }
        state = await this.action.store({
          chain: this.chain,
          lastHeight: lastHeight,
          syncedHeight: 0,
        });
        this.logger.debug(
          `Created RawDataProviderStateEntity on [${this.chain}] chain at height ${lastHeight}`,
        );
      }
      return state;
    };

  /**
   * Iterates through observations of the current chain and fills their rawData field.
   * Updates syncedHeight only after the complete extractor group at that height succeeds.
   *
   * @returns void
   */
  fillRawData = async (): Promise<void> => {
    this.logger.info(
      `RawDataProvider Starting raw-data filling for [${this.chain}] chain`,
    );

    let state: RawDataProviderStateEntity =
      await this.fetchOrCreateStateForChain();
    while (state.syncedHeight < state.lastHeight) {
      this.logger.debug(
        `RawDataProvider Fetching observations for [${this.chain}] chain from height > ${state.syncedHeight}`,
      );
      try {
        const result = await this.fillObservationsRawData(state);
        state = result;
      } catch (err) {
        this.logger.error(`RawDataProvider Error: ${err}`);
        if (err instanceof Error && err.stack) this.logger.error(err.stack);
        break;
      }
    }

    this.logger.info(
      `RawDataProvider Finished filling raw-data for [${this.chain}] chain`,
    );
  };

  /**
   * fetch transactions related to the input observation parameter
   *
   * @param observation
   * @returns { Promise<TxType[]> }
   */
  protected abstract fetchObservationTxs: (
    observation: ObservationEntity,
  ) => Promise<TxType[] | undefined>;

  /** Default replay preserves the extractor API used by non-EVM providers. */
  protected replayObservation = (
    txs: TxType[],
    observation: ObservationEntity,
    block: BlockInfo,
  ): Promise<boolean> => this.extractor.processTransactions(txs, block);

  /**
   * Process observation and write rawData
   *
   * @param observation
   * @return {boolean} determining result of process done successfully or no
   */
  protected processObservation = async (observation: ObservationEntity) => {
    try {
      const block = { height: observation.height, hash: observation.block };
      const txs = await this.fetchObservationTxs(observation);
      if (!txs?.length)
        throw new Error(
          `Transaction [${observation.sourceTxId}] not found or invalid response from ${this.chain} chain.`,
        );
      const success = await this.replayObservation(txs, observation, block);
      if (!success)
        throw new Error(
          `Extraction of observation [${observation.sourceTxId}] failed for ${this.chain}.`,
        );
      const stored = await this.dataSource
        .getRepository(ObservationEntity)
        .findOneBy({ id: observation.id });
      if (
        !stored?.rawData ||
        stored.rawData === 'raw-data extraction is off' ||
        Object.entries(observation).some(
          ([field, value]) =>
            field !== 'rawData' &&
            stored[field as keyof ObservationEntity] !== value,
        )
      )
        throw new Error(
          `Observation [${observation.sourceTxId}] was not repaired without changing its stored identity and payload.`,
        );
    } catch (err) {
      this.logger.error(
        `Processing of observation for ${this.chain} failed: ${err}`,
      );
      return false;
    }
    return true;
  };

  /**
   * Fills the raw data field for all ObservationEntity records of the current chain of input RawDataProviderStateEntity
   *
   * @param state
   * @returns
   */
  protected fillObservationsRawData = async (
    state: RawDataProviderStateEntity,
  ): Promise<RawDataProviderStateEntity> => {
    const batch = await this.action.fetchChainObservations(
      this.chain,
      state.syncedHeight,
      this.extractor.getId(),
    );

    if (batch.length === 0)
      throw new Error(
        `ImpossibleBehavior: No more observations found for [${this.chain}] chain`,
      );

    const height = batch[0].height;
    const observations = await this.action.fetchObservationsAtHeight(
      this.chain,
      height,
      this.extractor.getId(),
    );
    if (observations.length === 0)
      throw new Error(`Observation group at height ${height} disappeared`);

    for (const observation of observations) {
      this.logger.debug(
        `RawDataProvider Updating rawData for observation at height ${observation.height} for [${this.chain}] chain`,
      );
      const isSuccess = await this.processObservation(observation);
      if (isSuccess) {
        this.logger.debug(
          `RawDataProvider successfully processed observation at height ${observation.height} for [${this.chain}] chain`,
        );
      } else {
        throw new Error(
          `RawDataProvider failed to process observation at height ${observation.height} for [${this.chain}] chain`,
        );
      }
    }
    // Persist only after every row at this height succeeds. A failed group is
    // retried in full after restart, including rows beyond the batch limit.
    await this.action.store({ ...state, syncedHeight: height });
    state.syncedHeight = height;
    this.logger.debug(
      `RawDataProvider syncedHeight updated to ${height} for [${this.chain}] chain`,
    );
    return state;
  };
}
