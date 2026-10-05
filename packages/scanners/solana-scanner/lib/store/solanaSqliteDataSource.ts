import {
  migrations as observationMigrations,
  ObservationEntity,
} from '@rosen-bridge/abstract-observation-extractor';
import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations as scannerMigrations,
} from '@rosen-bridge/abstract-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import {
  SolanaObservationEvidenceEntity,
  SolanaScanStateEntity,
} from '../entities';
import { migrations as solanaMigrations } from '../migrations';

export const SOLANA_SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Creates an explicit local writer source; callers run migrations before service start. */
export const createSolanaSqliteWriterDataSource = (
  database: string,
): DataSource => {
  if (
    typeof database !== 'string' ||
    database.trim().length === 0 ||
    database === ':memory:'
  )
    throw new Error('SOLANA_SQLITE_FILE_REQUIRED');
  return new DataSource({
    type: 'sqlite',
    database,
    entities: [
      BlockEntity,
      ExtractorStatusEntity,
      ObservationEntity,
      SolanaScanStateEntity,
      SolanaObservationEvidenceEntity,
    ],
    migrations: [
      ...scannerMigrations.sqlite,
      ...observationMigrations.sqlite,
      ...solanaMigrations.sqlite,
    ],
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'all',
    logging: false,
    enableWAL: false,
    busyTimeout: SOLANA_SQLITE_BUSY_TIMEOUT_MS,
  });
};

/** Read a string or number from the only row of a SQLite pragma result. */
const singleValue = (
  rows: unknown,
  key: string,
): string | number | undefined => {
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row = rows[0] as Record<string, unknown>;
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
};

/** Applies and verifies the writer-only SQLite isolation and durability policy. */
export const configureSolanaSqliteWriter = async (
  dataSource: DataSource,
): Promise<void> => {
  await dataSource.query('PRAGMA journal_mode = DELETE');
  await dataSource.query('PRAGMA synchronous = FULL');
  await dataSource.query('PRAGMA read_uncommitted = OFF');
  const [journal, synchronous, readUncommitted, busyTimeout] =
    await Promise.all([
      dataSource.query('PRAGMA journal_mode'),
      dataSource.query('PRAGMA synchronous'),
      dataSource.query('PRAGMA read_uncommitted'),
      dataSource.query('PRAGMA busy_timeout'),
    ]);
  if (
    singleValue(journal, 'journal_mode') !== 'delete' ||
    singleValue(synchronous, 'synchronous') !== 2 ||
    singleValue(readUncommitted, 'read_uncommitted') !== 0 ||
    singleValue(busyTimeout, 'timeout') !== SOLANA_SQLITE_BUSY_TIMEOUT_MS
  )
    throw new Error('SOLANA_SQLITE_WRITER_POLICY');
};
