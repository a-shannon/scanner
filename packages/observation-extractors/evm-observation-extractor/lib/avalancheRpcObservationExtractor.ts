import { blake2b } from 'blakejs';
import { isCallException, Transaction, TransactionResponse } from 'ethers';

import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { ExtractedObservation } from '@rosen-bridge/abstract-observation-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { EvmEthersRosenExtractor } from '@rosen-bridge/rosen-extractor';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';
import { TokenMap } from '@rosen-bridge/tokens';

import { hasAvalancheTransferProof } from './avalancheTransferProof';
import { EvmRpcObservationExtractor } from './evmRpcObservationExtractor';

export class AvalancheRpcObservationExtractor extends EvmRpcObservationExtractor {
  readonly FROM_CHAIN = 'avalanche';
  private readonly avalancheLockAddress: string;

  /** Configures EVM observation extraction with Avalanche's native asset identity. */
  constructor(
    lockAddress: string,
    dataSource: DataSource,
    tokens: TokenMap,
    logger?: AbstractLogger,
    storeRawData = true,
  ) {
    super(
      dataSource,
      tokens,
      new EvmEthersRosenExtractor(
        lockAddress,
        tokens,
        'avalanche',
        'avax',
        logger?.child('EvmEthersRosenExtractor'),
        storeRawData,
      ),
      logger,
    );
    this.avalancheLockAddress = lockAddress;
  }

  /** Derive mapped locks, requiring receipt Transfer evidence for ERC20 assets. */
  extractObservations = async (
    txs: Array<TransactionResponse>,
    block: BlockInfo,
  ): Promise<ExtractedObservation[]> => {
    const observations: ExtractedObservation[] = [];
    for (const providerTransaction of txs) {
      const isNative =
        providerTransaction.to?.toLowerCase() ===
        this.avalancheLockAddress.toLowerCase();
      // Retain the native path. Detach signed ERC20 fields before awaiting RPC.
      let transaction = providerTransaction;
      if (!isNative) {
        try {
          const signed = Transaction.from(providerTransaction);
          if (
            signed.hash?.toLowerCase() !==
            providerTransaction.hash.toLowerCase()
          )
            continue;
          transaction = new TransactionResponse(
            {
              ...providerTransaction,
              signature: signed.signature!,
              accessList: signed.accessList,
            },
            providerTransaction.provider,
          );
          transaction.wait = providerTransaction.wait.bind(providerTransaction);
        } catch {
          continue;
        }
      }
      const data = this.extractor.get(transaction);
      if (!data) continue;
      try {
        const receipt = await transaction.wait(0);
        if (!receipt)
          throw Error(
            `ImpossibleBehavior: Evm Tx [${transaction.hash}] is included in block [${block.hash}] but waiting resulted is null or undefined`,
          );
        if (
          !isNative &&
          !hasAvalancheTransferProof(
            transaction,
            receipt,
            block,
            this.avalancheLockAddress,
          )
        )
          continue;
        observations.push({
          ...data,
          fromChain: this.FROM_CHAIN,
          sourceBlockId: block.hash,
          requestId: Buffer.from(
            blake2b(this.getTxId(transaction), undefined, 32),
          ).toString('hex'),
        });
      } catch (error) {
        if (!isCallException(error)) throw error;
        this.logger.debug(
          `found valid lock transaction [${transaction.hash}] but tx is failed`,
        );
      }
    }
    return observations;
  };

  /**
   * gets Id for current extractor
   */
  getId = () => 'avalanche-rpc-extractor';
}
