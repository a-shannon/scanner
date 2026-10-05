import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataSource } from '@rosen-bridge/extended-typeorm';

import { AvalancheRpcNetwork } from '../lib/avalancheRpcNetwork';
import {
  AvalancheRpcScanner,
  AvalancheScannerConfig,
} from '../lib/avalancheRpcScanner';
import { AvalancheSafetyState1790769600000 } from '../lib/avalancheSafetyState';
import { openDatabase } from './avalancheScannerTestUtils';
import { mockScannerNetwork } from './mocked/avalancheScannerNetwork.mock';

describe('AvalancheSafetyState1790769600000', () => {
  let database: DataSource;
  let databasePath: string;
  let network: AvalancheRpcNetwork;
  let config: AvalancheScannerConfig;
  beforeEach(async () => {
    databasePath = join(tmpdir(), `avalanche-scanner-${randomUUID()}.sqlite`);
    database = await openDatabase(databasePath);
    network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
    mockScannerNetwork(network);
    config = {
      dataSource: database,
      network,
      initialHeight: 0,
      sourceId: 'operator-fuji-a',
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 2000,
      },
    };
  });
  afterEach(async () => {
    network['provider'].destroy();
    if (database.isInitialized) await database.destroy();
    unlinkSync(databasePath);
    vi.restoreAllMocks();
  });
  describe('down', () => {
    /**
     * @target AvalancheSafetyState1790769600000.down prevents a migration
     * rollback from erasing populated safety state
     * @dependencies
     * - File SQLite database with the actual abstract-scanner and Avalanche
     * safety migrations, QueryRunner and scanner safety repository.
     * - Actual AvalancheRpcScanner and explicit Fuji network with mocked
     * settled height, contiguous headers and empty transaction batches.
     * @scenario
     * - Run the actual scanner update to persist qualified safety state.
     * - Attempt to roll back its migration and release the QueryRunner.
     * @expected
     * - Rollback rejects while populated safety state exists.
     */

    it('prevents a migration rollback from erasing populated safety state', async () => {
      await new AvalancheRpcScanner(config).update();
      const runner = database.createQueryRunner();
      try {
        await expect(async () => {
          await new AvalancheSafetyState1790769600000().down(runner);
        }).rejects.toThrow('populated Avalanche safety state');
      } finally {
        await runner.release();
      }
    });
  });
});
