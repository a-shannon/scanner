import { JsonRpcProvider, TransactionResponse } from 'ethers';

import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import {
  AvalancheRpcObservationExtractor,
  BinanceRpcObservationExtractor,
  EthereumRpcObservationExtractor,
} from '@rosen-bridge/evm-observation-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';
import axios from '@rosen-clients/rate-limited-axios';

import { AbstractRawDataProvider } from '../../abstractRawDataProvider';
import { ConnectionByAuthInfoInterface } from '../../types';

export class EvmRawDataProvider extends AbstractRawDataProvider<TransactionResponse> {
  protected client: JsonRpcProvider;
  protected chain: 'ethereum' | 'binance' | 'avalanche';

  /**
   * Selects the supported extractor's chain and creates its RPC provider.
   * @param dataSource - Database containing stored observations and provider state.
   * @param extractor - Ethereum, Binance or Avalanche observation extractor.
   * @param evmConnectionInfo - RPC endpoint and optional authentication settings.
   * @param logger - Provider logger.
   */
  constructor(
    protected dataSource: DataSource,
    protected extractor:
      | EthereumRpcObservationExtractor
      | BinanceRpcObservationExtractor
      | AvalancheRpcObservationExtractor,
    evmConnectionInfo: ConnectionByAuthInfoInterface,
    protected logger: AbstractLogger,
  ) {
    let chain: 'ethereum' | 'binance' | 'avalanche';
    if (extractor instanceof EthereumRpcObservationExtractor)
      chain = 'ethereum';
    else if (extractor instanceof BinanceRpcObservationExtractor)
      chain = 'binance';
    else if (extractor instanceof AvalancheRpcObservationExtractor)
      chain = 'avalanche';
    else throw new Error('Unsupported EVM observation extractor');
    super(chain, dataSource, extractor, logger);
    this.chain = chain;
    let url = evmConnectionInfo.url;
    if (evmConnectionInfo.authToken)
      url = axios.getUri({
        baseURL: evmConnectionInfo.url,
        url: evmConnectionInfo.authToken,
      });
    this.client = new JsonRpcProvider(url, undefined);
  }

  /** Validate the derived payload before updating only this row's raw data. */
  protected replayObservation = async (
    txs: TransactionResponse[],
    observation: ObservationEntity,
    block: BlockInfo,
  ): Promise<boolean> => {
    const extracted = await this.extractor.extractObservations(txs, block);
    if (extracted.length !== 1)
      throw new Error('Replay must derive exactly one stored observation');
    const candidate: ObservationEntity = {
      ...extracted[0],
      id: observation.id,
      height: block.height,
      block: block.hash,
      extractor: this.extractor.getId(),
    };
    if (
      !candidate.rawData ||
      candidate.rawData === 'raw-data extraction is off' ||
      candidate.fromChain !== this.chain ||
      Object.entries(candidate).some(
        ([field, value]) =>
          field !== 'rawData' &&
          observation[field as keyof ObservationEntity] !== value,
      )
    )
      throw new Error('Replay payload does not match the stored observation');

    const repository = this.dataSource.getRepository(ObservationEntity);
    const updated = await repository.update(observation, {
      rawData: candidate.rawData,
    });
    if (updated.affected !== 1)
      throw new Error('Stored observation changed during raw-data replay');
    if (
      !(await repository.findOneBy({
        ...observation,
        rawData: candidate.rawData,
      }))
    )
      throw new Error('Raw-data replay postcondition no longer holds');
    return true;
  };

  /**
   * fetch evm transactions related to the input observation parameter
   *
   * @param observation
   * @returns { Promise<TransactionResponse[]> }
   */
  protected fetchObservationTxs = async (
    observation: ObservationEntity,
  ): Promise<TransactionResponse[] | undefined> => {
    try {
      const block = await this.client.getBlock(observation.height, true);
      if (
        !block ||
        block.number !== observation.height ||
        block.hash !== observation.block ||
        block.hash !== observation.sourceBlockId
      )
        throw new Error('RPC block does not match the stored observation');

      const transactions = block.prefetchedTransactions.filter(
        (tx) => tx.hash === observation.sourceTxId,
      );
      if (
        transactions.length !== 1 ||
        transactions[0].blockHash !== block.hash ||
        transactions[0].blockNumber !== block.number
      )
        throw new Error(
          'RPC transaction does not match the stored observation',
        );
      return transactions;
    } catch (err) {
      throw new Error(
        `Fetch transactions by [${observation.sourceTxId}] id of related observation for [${this.chain}] chain failed: ${err}`,
      );
    }
  };
}
