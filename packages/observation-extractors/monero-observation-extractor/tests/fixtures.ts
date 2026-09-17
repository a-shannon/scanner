import { blake2b } from 'blakejs';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import {
  BlockEntity,
  ExtractorStatusEntity,
  GeneralScanner,
} from '@rosen-bridge/abstract-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { Block } from '@rosen-bridge/scanner-interfaces';

import { MoneroCandidateEntity } from '../lib/entities/moneroCandidateEntity';
import {
  AdmissionResult,
  CandidateStoreOptions,
  MoneroCandidate,
  MoneroCandidateInput,
} from '../lib/types';

export const hex = (value: number) => value.toString(16).padStart(64, '0');
export const input = (value: number): MoneroCandidateInput => ({
  txId: hex(value),
  transactionHex: 'aa' + value.toString(16).padStart(2, '0'),
});
export const options: CandidateStoreOptions = {
  extractorId: 'monero-deposits',
  scannerId: 'monero',
  scope: hex(900),
  maxCandidates: 100,
  maxTransactionBytes: 1000,
  leaseMs: 1000,
  retryMs: 10,
};
export const accepted = (candidate: MoneroCandidate): AdmissionResult => ({
  status: 'accepted',
  observation: {
    fromChain: 'monero',
    toChain: 'ergo',
    fromAddress: 'output-origin-descriptor',
    toAddress: 'destination',
    amount: '10000',
    networkFee: '1',
    bridgeFee: '1',
    sourceChainTokenId: 'xmr',
    targetChainTokenId: 'wrapped-xmr',
    sourceTxId: candidate.txId,
    sourceBlockId: candidate.sourceBlockId,
    requestId: Buffer.from(blake2b(candidate.txId, undefined, 32)).toString(
      'hex',
    ),
    rawData: '',
  },
});

export const openDatabase = async (database: string, synchronize = false) => {
  const source = new DataSource({
    type: 'sqlite',
    database,
    synchronize,
    entities: [
      BlockEntity,
      ExtractorStatusEntity,
      ObservationEntity,
      MoneroCandidateEntity,
    ],
    busyTimeout: 1000,
  });
  return source.initialize();
};

export const diskFixture = async () => {
  const database = join(tmpdir(), `monero-admission-${randomUUID()}.sqlite`);
  const scannerDb = await openDatabase(database, true);
  const admissionDb = await openDatabase(database);
  return {
    database,
    scannerDb,
    admissionDb,
    async close() {
      if (admissionDb.isInitialized) await admissionDb.destroy();
      if (scannerDb.isInitialized) await scannerDb.destroy();
      await unlink(database);
    },
  };
};

export class TestScanner extends GeneralScanner<MoneroCandidateInput> {}
export const chainFixture = (transactions: MoneroCandidateInput[][]) => {
  const blocks: Block[] = transactions.map((txs, height) => ({
    hash: hex(100 + height),
    parentHash: hex(99 + height),
    height,
    timestamp: 1000 + height,
    txCount: txs.length,
  }));
  return {
    blocks,
    transactions,
    network: {
      getCurrentHeight: async () => blocks.length - 1,
      getBlockAtHeight: async (height: number) => blocks[height],
      getBlockTxs: async (hash: string, height: number) => {
        if (hash !== blocks[height].hash) throw Error('source changed');
        return transactions[height];
      },
    },
  };
};
