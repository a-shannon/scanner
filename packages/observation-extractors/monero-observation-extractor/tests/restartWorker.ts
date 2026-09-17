import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';

import { MoneroObservationExtractor } from '../lib/moneroObservationExtractor';
import { MoneroCandidateInput } from '../lib/types';
import {
  accepted,
  chainFixture,
  input,
  openDatabase,
  options,
  TestScanner,
} from './fixtures';

const [database, mode] = process.argv.slice(2);
if (!database || !['capture-crash', 'recover'].includes(mode))
  throw Error('worker arguments');
const scannerDb = await openDatabase(database);
const admissionDb = await openDatabase(database);
const ex = new MoneroObservationExtractor<MoneroCandidateInput>(
  scannerDb,
  admissionDb,
  options,
  (tx) => tx,
  async (candidate) => accepted(candidate),
);
const capture = ex.processTransactions;
ex.processTransactions = async (txs, block) => {
  await capture(txs, block);
  // Abrupt exit after SQLite's capture commit, before scanner status commit.
  if (mode === 'capture-crash' && block.height === 1) process.exit(17);
  return true;
};
const chain = chainFixture([[], [input(1)], [input(2)]]);
const scanner = new TestScanner('monero', scannerDb, -1, chain.network);
await scanner.registerExtractor(ex);
await scanner.update();
const result = await ex.processPending(2);
console.log(
  JSON.stringify({
    result,
    cursor: (await scanner.action.getLastSavedBlock())?.height,
    observations: await scannerDb.getRepository(ObservationEntity).count(),
  }),
);
await admissionDb.destroy();
await scannerDb.destroy();
