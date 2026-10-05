import { blake2b } from 'blakejs';
import { isCallException, TransactionResponse } from 'ethers';

import {
  AbstractObservationExtractor,
  ExtractedObservation,
} from '@rosen-bridge/abstract-observation-extractor';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';

export abstract class EvmRpcObservationExtractor extends AbstractObservationExtractor<TransactionResponse> {
  /**
   * Derives observations from successful Rosen transactions without writing them.
   * @param block
   * @param txs
   */
  extractObservations = async (
    txs: Array<TransactionResponse>,
    block: BlockInfo,
  ): Promise<ExtractedObservation[]> => {
    const observations: Array<ExtractedObservation> = [];
    for (const transaction of txs) {
      const data = this.extractor.get(transaction);
      if (data) {
        try {
          const result = await transaction.wait(0);
          if (result) {
            const requestId = Buffer.from(
              blake2b(this.getTxId(transaction), undefined, 32),
            ).toString('hex');
            observations.push({
              fromChain: this.FROM_CHAIN,
              toChain: data.toChain,
              amount: data.amount,
              sourceChainTokenId: data.sourceChainTokenId,
              targetChainTokenId: data.targetChainTokenId,
              sourceTxId: data.sourceTxId,
              bridgeFee: data.bridgeFee,
              networkFee: data.networkFee,
              sourceBlockId: block.hash,
              requestId: requestId,
              toAddress: data.toAddress,
              fromAddress: data.fromAddress,
              rawData: data.rawData,
            });
          } else
            throw Error(
              `ImpossibleBehavior: Evm Tx [${transaction.hash}] is included in block [${block.hash}] but waiting resulted is null or undefined`,
            );
        } catch (e) {
          if (isCallException(e))
            this.logger.debug(
              `found valid lock transaction [${transaction.hash}] but tx is failed`,
            );
          else throw e;
        }
      }
    }
    return observations;
  };

  /** Derives and stores observations during normal block ingestion. */
  processTransactions = async (
    txs: Array<TransactionResponse>,
    block: BlockInfo,
  ): Promise<boolean> =>
    this.actions.storeObservations(
      await this.extractObservations(txs, block),
      block,
      this.getId(),
    );

  /**
   * gets transaction id from TransactionType
   */
  getTxId = (tx: TransactionResponse) => {
    if (tx.hash == null) {
      throw Error(
        'ImpossibleBehavior: Transactions coming from RPC have to be signed.',
      );
    }
    return tx.hash;
  };
}
