import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
} from '@rosen-bridge/abstract-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { Block } from '@rosen-bridge/scanner-interfaces';

import {
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '../lib/avalancheSafetyState';

/**
 * Build a deterministic synthetic block hash for a height.
 */
export const hash = (height: number) =>
  '0x' + height.toString(16).padStart(64, '0');
/**
 * Build a contiguous synthetic block header for a height.
 */
export const block = (height: number): Block => ({
  height,
  hash: hash(height),
  parentHash: hash(height - 1),
  timestamp: 1790769600 + height,
  txCount: 0,
});

/**
 * Open the isolated scanner database and apply its migrations.
 */
export const openDatabase = async (databasePath: string) => {
  const source = new DataSource({
    type: 'sqlite',
    database: databasePath,
    entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
    migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
    synchronize: false,
  });
  await source.initialize();
  await source.runMigrations();
  return source;
};
