import { blake2b } from 'blakejs';
import { Buffer } from 'node:buffer';

import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import {
  BlockEntity,
  ExtractorStatusEntity,
  PROCEED,
} from '@rosen-bridge/abstract-scanner';
import { DataSource, QueryRunner } from '@rosen-bridge/extended-typeorm';

import {
  SolanaObservationEvidenceEntity,
  SolanaScanStateEntity,
} from '../entities';
import { SolanaStoreFault } from '../errors';
import {
  bindSolanaScanProfile,
  expectedSolanaFee,
  SolanaScanProfile,
  validateSolanaScanProfile,
} from '../profile';
import {
  SolanaScanState,
  SolanaScanStateUpdate,
  SolanaScannedBlock,
  SolanaRpcBlock,
  SolanaScanRef,
} from '../types';
import { isCanonicalBase58 } from '../validation/base58';
import {
  configureSolanaSqliteWriter,
  createSolanaSqliteWriterDataSource,
  SOLANA_SQLITE_BUSY_TIMEOUT_MS,
} from './solanaSqliteDataSource';
import { SolanaScanStorePort } from './storePort';

const SOLANA_CHAIN = 'solana';
const MAX_ROSEN_HEIGHT = 2_147_483_647;
const MAX_SLOT = Number.MAX_SAFE_INTEGER;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_BLOCKS_PER_BATCH = 4096;
const MAX_TRANSACTION_REFERENCES_PER_BATCH = 262_144;
const MAX_OBSERVATIONS_PER_BATCH = 65_536;
const BLOCK_PENDING = 'PROCESSING';
const SOLANA_SLOT_METADATA_PREFIX = 'solana-slot-v1:';
/** Encode a slot using the metadata prefix stored on scanner block rows. */
const solanaSlotMetadata = (slot: number): string =>
  `${SOLANA_SLOT_METADATA_PREFIX}${slot}`;
const EVIDENCE_QUERY_PARAMETER_LIMIT = 900;
const EVIDENCE_PAGE_SIZE = 256;

type SqliteWriterFactory = (database: string) => DataSource;
type DbRow = Record<string, unknown>;

/** Narrow a non-null, non-array object to a database row. */
const isRecord = (value: unknown): value is DbRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Require query output to be an array of row objects. */
const rowsOf = (value: unknown, code: string): DbRow[] => {
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new SolanaStoreFault(code, 'unavailable');
  return value;
};

/** Read a numeric affected-row count when the result provides one. */
const affectedOf = (value: unknown): number | undefined =>
  isRecord(value) && typeof value.affected === 'number'
    ? value.affected
    : undefined;

/** Compare references by slot, block height, and block hash. */
const sameRef = (left: SolanaScanRef, right: SolanaScanRef): boolean =>
  left.slot === right.slot &&
  left.blockHeight === right.blockHeight &&
  left.blockhash === right.blockhash;

/** Check for an unsigned decimal amount string of at most 39 digits. */
const validAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);

/** Check that text is non-empty and within the supplied length bound. */
const validText = (value: unknown, maxLength = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

/** Read a string driver error code from an object-shaped error. */
const databaseErrorCode = (error: unknown): string | undefined => {
  if (!isRecord(error) || !isRecord(error.driverError)) return undefined;
  return typeof error.driverError.code === 'string'
    ? error.driverError.code
    : undefined;
};

export class SqliteSolanaScanStore implements SolanaScanStorePort {
  private readonly profile: SolanaScanProfile;
  private readonly configBinding: string;
  private readonly operationQueue: { current: Promise<void> } = {
    current: Promise.resolve(),
  };
  private writer: DataSource | undefined;
  private writerFailure: SolanaStoreFault | undefined;
  private writerHistoryValidated = false;
  private exclusive = false;
  private closed = false;

  /** Copy and bind the scan profile, then retain the configured database writer. */
  constructor(
    profile: SolanaScanProfile,
    private readonly database: string,
    private readonly writerFactory: SqliteWriterFactory = createSolanaSqliteWriterDataSource,
  ) {
    validateSolanaScanProfile(profile);
    if (
      typeof database !== 'string' ||
      database.trim().length === 0 ||
      database === ':memory:'
    )
      throw new Error('SOLANA_SQLITE_FILE_REQUIRED');
    this.profile = {
      ...profile,
      anchor: { ...profile.anchor },
      assets: profile.assets.map((asset) => ({ ...asset })),
    };
    this.configBinding = bindSolanaScanProfile(this.profile);
  }

  /** Serialize scan callbacks and mark the active callback as exclusive. */
  withExclusiveScan = <T>(operation: () => Promise<T>): Promise<T> => {
    if (this.closed)
      return Promise.reject(
        new SolanaStoreFault('STORE_CLOSED', 'unavailable'),
      );
    const result = this.operationQueue.current.then(async () => {
      if (this.closed)
        throw new SolanaStoreFault('STORE_CLOSED', 'unavailable');
      this.exclusive = true;
      try {
        return await operation();
      } finally {
        this.exclusive = false;
      }
    });
    this.operationQueue.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** Reject future operations, wait for queued work, and dispose the writer. */
  close = async (): Promise<void> => {
    this.closed = true;
    await this.operationQueue.current;
    await this.disposeWriter();
  };

  /** Read the validated persisted state during an exclusive scan operation. */
  readState = async (): Promise<SolanaScanState | undefined> => {
    this.requireExclusive();
    return this.readSnapshot();
  };

  /** Return the binding digest derived from the copied scan profile. */
  getProfileBinding = (): string => this.configBinding;

  /** Initialize an empty store from its anchor block or return existing state. */
  initialize = async (
    anchorBlock: SolanaRpcBlock,
  ): Promise<SolanaScanState> => {
    this.requireExclusive();
    const existing = await this.readSnapshot();
    if (existing) return existing;
    this.validateAnchorBlock(anchorBlock);

    try {
      await this.withTransaction(async (runner) => {
        await runner.manager.getRepository(SolanaScanStateEntity).insert({
          id: 1,
          schemaVersion: 1,
          genesisHash: this.profile.genesisHash,
          scannerId: this.profile.scannerId,
          extractorId: this.profile.extractorId,
          configBinding: this.configBinding,
          anchorSlot: this.profile.anchor.slot,
          anchorBlockHeight: this.profile.anchor.blockHeight,
          anchorBlockhash: this.profile.anchor.blockhash,
          cursorSlot: this.profile.anchor.slot,
          cursorBlockHeight: this.profile.anchor.blockHeight,
          cursorBlockhash: this.profile.anchor.blockhash,
          scannedThroughSlot: this.profile.anchor.slot,
          revision: 0,
          holdCode: null,
        });
        await this.insertBlock(runner, anchorBlock);
        await runner.manager.getRepository(ExtractorStatusEntity).insert({
          scannerId: this.profile.scannerId,
          extractorId: this.profile.extractorId,
          updateHeight: anchorBlock.blockHeight,
          updateBlockHash: anchorBlock.blockhash,
        });
        await this.markBlockProceed(runner, anchorBlock);
      });
    } catch (error) {
      if (
        error instanceof SolanaStoreFault &&
        (error.code === 'COMMIT_UNCERTAIN' || error.kind === 'content')
      ) {
        const racedState = await this.readSnapshot();
        if (racedState) return racedState;
      }
      throw error;
    }

    const initialized = await this.readSnapshot();
    if (
      !initialized ||
      initialized.revision !== 0 ||
      !sameRef(initialized.cursor, this.profile.anchor)
    )
      throw new SolanaStoreFault('INITIALIZATION_SNAPSHOT', 'identity');
    return initialized;
  };

  /** Validate and atomically install a batch under its expected state revision. */
  installBatch = async (
    expectedRevision: number,
    next: SolanaScanStateUpdate,
    blocks: SolanaScannedBlock[],
  ): Promise<SolanaScanState> => {
    this.requireExclusive();
    const before = await this.readSnapshot();
    if (!before) throw new SolanaStoreFault('STATE_MISSING', 'identity');
    if (before.revision !== expectedRevision)
      throw new SolanaStoreFault('REVISION_CONFLICT', 'conflict');
    this.validateBatch(before, next, blocks);
    if (before.revision >= MAX_REVISION)
      throw new SolanaStoreFault('REVISION_EXHAUSTED', 'unavailable');

    try {
      await this.withTransaction(async (runner) => {
        const cas = await runner.query(
          `UPDATE "solana_scan_state"
           SET "revision" = "revision" + 1
           WHERE "id" = 1 AND "schemaVersion" = 1 AND "revision" = ?
             AND "holdCode" IS NULL AND "genesisHash" = ?
             AND "scannerId" = ? AND "extractorId" = ? AND "configBinding" = ?
             AND "anchorSlot" = ? AND "anchorBlockHeight" = ? AND "anchorBlockhash" = ?
             AND "cursorSlot" = ? AND "cursorBlockHeight" = ? AND "cursorBlockhash" = ?
             AND "scannedThroughSlot" = ?`,
          [
            expectedRevision,
            this.profile.genesisHash,
            this.profile.scannerId,
            this.profile.extractorId,
            this.configBinding,
            this.profile.anchor.slot,
            this.profile.anchor.blockHeight,
            this.profile.anchor.blockhash,
            before.cursor.slot,
            before.cursor.blockHeight,
            before.cursor.blockhash,
            before.scannedThroughSlot,
          ],
          true,
        );
        if (affectedOf(cas) !== 1)
          throw new SolanaStoreFault('REVISION_CONFLICT', 'conflict');

        await this.assertNoPreviouslyProvenSignatures(
          runner,
          blocks.flatMap((scanned) =>
            scanned.block.transactions.map(
              (transaction) => transaction.signature,
            ),
          ),
        );

        for (const scanned of blocks)
          await this.insertBlock(runner, scanned.block);
        for (const scanned of blocks) {
          for (const candidate of scanned.deposits)
            await this.insertObservation(runner, scanned.block, candidate);
        }
        for (const scanned of blocks)
          await this.markBlockProceed(runner, scanned.block);

        const statusUpdate = await runner.manager
          .getRepository(ExtractorStatusEntity)
          .update(
            {
              scannerId: this.profile.scannerId,
              extractorId: this.profile.extractorId,
            },
            {
              updateHeight: next.cursor.blockHeight,
              updateBlockHash: next.cursor.blockhash,
            },
          );
        if (statusUpdate.affected !== 1)
          throw new SolanaStoreFault('STATUS_MISSING', 'content');

        const progressUpdate = await runner.query(
          `UPDATE "solana_scan_state"
           SET "cursorSlot" = ?, "cursorBlockHeight" = ?, "cursorBlockhash" = ?,
               "scannedThroughSlot" = ?
           WHERE "id" = 1 AND "revision" = ? AND "holdCode" IS NULL
             AND "genesisHash" = ? AND "scannerId" = ? AND "extractorId" = ?
             AND "configBinding" = ?`,
          [
            next.cursor.slot,
            next.cursor.blockHeight,
            next.cursor.blockhash,
            next.scannedThroughSlot,
            expectedRevision + 1,
            this.profile.genesisHash,
            this.profile.scannerId,
            this.profile.extractorId,
            this.configBinding,
          ],
          true,
        );
        if (affectedOf(progressUpdate) !== 1)
          throw new SolanaStoreFault('STATE_PROJECTION', 'content');
      });
    } catch (error) {
      if (
        error instanceof SolanaStoreFault &&
        error.code === 'COMMIT_UNCERTAIN'
      )
        return this.resolveInstallCommit(
          before,
          expectedRevision,
          next,
          blocks,
        );
      throw error;
    }

    const committed = await this.readSnapshot();
    if (
      !committed ||
      committed.revision !== expectedRevision + 1 ||
      committed.scannedThroughSlot !== next.scannedThroughSlot ||
      !sameRef(committed.cursor, next.cursor)
    )
      throw new SolanaStoreFault('COMMIT_SNAPSHOT_MISMATCH', 'identity');
    return committed;
  };

  /** Persist a validated hold code using a guarded revision update. */
  persistHold = async (
    expectedRevision: number,
    code: string,
  ): Promise<void> => {
    this.requireExclusive();
    if (!/^[A-Z0-9_-]{1,64}$/.test(code))
      throw new SolanaStoreFault('HOLD_CODE_SCHEMA', 'identity');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new SolanaStoreFault('REVISION_SCHEMA', 'identity');
    if (expectedRevision >= MAX_REVISION)
      throw new SolanaStoreFault('REVISION_EXHAUSTED', 'unavailable');
    try {
      await this.withTransaction(async (runner) => {
        const result = await runner.query(
          `UPDATE "solana_scan_state"
           SET "revision" = "revision" + 1, "holdCode" = ?
           WHERE "id" = 1 AND "schemaVersion" = 1 AND "revision" = ?
             AND "holdCode" IS NULL AND "genesisHash" = ?
             AND "scannerId" = ? AND "extractorId" = ? AND "configBinding" = ?
             AND "anchorSlot" = ? AND "anchorBlockHeight" = ? AND "anchorBlockhash" = ?`,
          [
            code,
            expectedRevision,
            this.profile.genesisHash,
            this.profile.scannerId,
            this.profile.extractorId,
            this.configBinding,
            this.profile.anchor.slot,
            this.profile.anchor.blockHeight,
            this.profile.anchor.blockhash,
          ],
          true,
        );
        if (affectedOf(result) !== 1)
          throw new SolanaStoreFault('HOLD_REVISION_CONFLICT', 'conflict');
      });
    } catch (error) {
      if (
        error instanceof SolanaStoreFault &&
        error.code === 'COMMIT_UNCERTAIN'
      ) {
        const resolved = await this.readSnapshot();
        if (
          resolved?.revision === expectedRevision + 1 &&
          resolved.holdCode === code
        )
          return;
      } else {
        throw error;
      }
    }
    const held = await this.readSnapshot();
    if (held?.revision !== expectedRevision + 1 || held.holdCode !== code)
      throw new SolanaStoreFault('HOLD_SNAPSHOT_MISMATCH', 'identity');
  };

  /** Reject operations when the store is closed or no scan callback is active. */
  private requireExclusive = (): void => {
    if (this.closed) throw new SolanaStoreFault('STORE_CLOSED', 'unavailable');
    if (!this.exclusive)
      throw new SolanaStoreFault('STORE_OPERATION_NOT_EXCLUSIVE', 'identity');
  };

  /** Open and validate the configured SQLite writer before first use. */
  private ensureWriter = async (): Promise<DataSource> => {
    if (this.writerFailure) throw this.writerFailure;
    if (this.writer) return this.writer;
    let candidate: DataSource | undefined;
    try {
      candidate = this.writerFactory(this.database);
      const options = candidate.options as unknown as Record<string, unknown>;
      if (
        options.type !== 'sqlite' ||
        options.synchronize !== false ||
        options.migrationsRun !== false ||
        options.migrationsTransactionMode !== 'all' ||
        options.enableWAL !== false ||
        options.busyTimeout !== SOLANA_SQLITE_BUSY_TIMEOUT_MS ||
        options.busyErrorRetry !== undefined
      )
        throw new SolanaStoreFault('WRITER_CONFIGURATION', 'identity');
      await candidate.initialize();
      await configureSolanaSqliteWriter(candidate);
      if (await candidate.showMigrations())
        throw new SolanaStoreFault('MIGRATIONS_REQUIRED', 'identity');
      this.writer = candidate;
      this.writerHistoryValidated = false;
      return candidate;
    } catch (error) {
      if (candidate?.isInitialized) {
        try {
          await candidate.destroy();
        } catch {
          this.writerFailure = new SolanaStoreFault(
            'WRITER_CLOSE',
            'unavailable',
          );
          throw this.writerFailure;
        }
      }
      if (error instanceof SolanaStoreFault) throw error;
      throw new SolanaStoreFault('WRITER_OPEN', 'unavailable');
    }
  };

  /** Clear cached writer state and destroy an initialized writer connection. */
  private disposeWriter = async (): Promise<void> => {
    const current = this.writer;
    this.writer = undefined;
    this.writerHistoryValidated = false;
    if (!current?.isInitialized) return;
    try {
      await current.destroy();
    } catch {
      this.writerFailure = new SolanaStoreFault('WRITER_CLOSE', 'unavailable');
      throw this.writerFailure;
    }
  };

  /** Run an operation in a query-runner transaction and classify failures. */
  private withTransaction = async <T>(
    operation: (runner: QueryRunner) => Promise<T>,
  ): Promise<T> => {
    const dataSource = await this.ensureWriter();
    const runner = dataSource.createQueryRunner();
    let started = false;
    let commitAttempted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      started = true;
      const result = await operation(runner);
      commitAttempted = true;
      await runner.commitTransaction();
      started = false;
      return result;
    } catch (error) {
      if (commitAttempted) {
        await this.disposeWriter();
        throw new SolanaStoreFault('COMMIT_UNCERTAIN', 'unavailable');
      }
      if (started) {
        try {
          await runner.rollbackTransaction();
          started = false;
        } catch {
          this.writerFailure = new SolanaStoreFault(
            'WRITER_ROLLBACK',
            'unavailable',
          );
          await this.disposeWriter();
          throw this.writerFailure;
        }
      } else {
        await this.disposeWriter();
      }
      throw this.classifyError(error);
    } finally {
      try {
        await runner.release();
      } catch {
        // SQLite query-runner release only clears transient metadata.
      }
    }
  };

  /** Map known SQLite busy and constraint codes to store fault categories. */
  private classifyError = (error: unknown): unknown => {
    if (error instanceof SolanaStoreFault) return error;
    const code = databaseErrorCode(error);
    if (code?.startsWith('SQLITE_BUSY') || code?.startsWith('SQLITE_LOCKED'))
      return new SolanaStoreFault('SQLITE_BUSY', 'conflict');
    if (code?.startsWith('SQLITE_CONSTRAINT'))
      return new SolanaStoreFault('STORE_CONTENT_CONFLICT', 'content');
    return new SolanaStoreFault('STORE_FAILURE', 'unavailable');
  };

  /** Read singleton state and validate its block, status, and evidence projections. */
  private readSnapshot = async (): Promise<SolanaScanState | undefined> => {
    const validateHistory = !this.writerHistoryValidated;
    const snapshot = await this.withTransaction(async (runner) => {
      const stateRows = rowsOf(
        await runner.query('SELECT * FROM "solana_scan_state" WHERE "id" = 1'),
        'STATE_READ',
      );
      if (stateRows.length === 0) {
        const orphanRows = rowsOf(
          await runner.query(
            `SELECT
              (SELECT COUNT(*) FROM "block_entity" WHERE "scanner" = ?) AS "blocks",
              (SELECT COUNT(*) FROM "extractor_status_entity" WHERE "scannerId" = ? AND "extractorId" = ?) AS "status",
              (SELECT COUNT(*) FROM "observation_entity" WHERE "extractor" = ?) AS "observations",
              (SELECT COUNT(*) FROM "solana_observation_evidence") AS "evidence"`,
            [
              this.profile.scannerId,
              this.profile.scannerId,
              this.profile.extractorId,
              this.profile.extractorId,
            ],
          ),
          'ORPHAN_READ',
        );
        const orphan = orphanRows[0];
        if (
          !orphan ||
          [
            orphan.blocks,
            orphan.status,
            orphan.observations,
            orphan.evidence,
          ].some((count) => count !== 0)
        )
          throw new SolanaStoreFault('ORPHANED_SOLANA_DATA', 'identity');
        return undefined;
      }
      if (stateRows.length !== 1)
        throw new SolanaStoreFault('STATE_SINGLETON', 'identity');
      const state = this.stateFromRow(stateRows[0]);
      this.validateStateIdentity(state);

      const anchorBlocks = rowsOf(
        await runner.query(
          `SELECT "extra", "status" FROM "block_entity"
           WHERE "scanner" = ? AND "height" = ? AND "hash" = ?`,
          [
            this.profile.scannerId,
            state.anchor.blockHeight,
            state.anchor.blockhash,
          ],
        ),
        'ANCHOR_BLOCK_READ',
      );
      if (
        anchorBlocks.length !== 1 ||
        anchorBlocks[0].extra !== solanaSlotMetadata(state.anchor.slot) ||
        anchorBlocks[0].status !== PROCEED
      )
        throw new SolanaStoreFault('ANCHOR_BLOCK_MISMATCH', 'identity');

      const cursorBlocks = rowsOf(
        await runner.query(
          `SELECT "id", "extra" FROM "block_entity"
           WHERE "scanner" = ? AND "height" = ? AND "hash" = ? AND "status" = ?`,
          [
            this.profile.scannerId,
            state.cursor.blockHeight,
            state.cursor.blockhash,
            PROCEED,
          ],
        ),
        'CURSOR_BLOCK_READ',
      );
      if (
        cursorBlocks.length !== 1 ||
        cursorBlocks[0].extra !== solanaSlotMetadata(state.cursor.slot)
      )
        throw new SolanaStoreFault('CURSOR_BLOCK_MISMATCH', 'identity');

      const aheadRows = rowsOf(
        await runner.query(
          `SELECT COUNT(*) AS "count" FROM "block_entity"
           WHERE "scanner" = ? AND "status" = ? AND "height" > ?`,
          [this.profile.scannerId, PROCEED, state.cursor.blockHeight],
        ),
        'AHEAD_BLOCK_READ',
      );
      if (aheadRows.length !== 1 || aheadRows[0].count !== 0)
        throw new SolanaStoreFault('BLOCK_AHEAD_OF_CURSOR', 'identity');

      const incompleteRows = rowsOf(
        await runner.query(
          `SELECT COUNT(*) AS "count" FROM "block_entity"
           WHERE "scanner" = ? AND "status" <> ?`,
          [this.profile.scannerId, PROCEED],
        ),
        'INCOMPLETE_BLOCK_READ',
      );
      if (incompleteRows.length !== 1 || incompleteRows[0].count !== 0)
        throw new SolanaStoreFault('INCOMPLETE_BLOCK_PROJECTION', 'identity');

      const statusRows = rowsOf(
        await runner.query(
          `SELECT "updateHeight", "updateBlockHash" FROM "extractor_status_entity"
           WHERE "scannerId" = ? AND "extractorId" = ?`,
          [this.profile.scannerId, this.profile.extractorId],
        ),
        'STATUS_READ',
      );
      if (
        statusRows.length !== 1 ||
        statusRows[0].updateHeight !== state.cursor.blockHeight ||
        statusRows[0].updateBlockHash !== state.cursor.blockhash
      )
        throw new SolanaStoreFault('STATUS_CURSOR_MISMATCH', 'identity');

      const preAnchorRows = rowsOf(
        await runner.query(
          `SELECT
             (SELECT COUNT(*) FROM "block_entity" WHERE "scanner" = ? AND "height" < ?) AS "blocks",
             (SELECT COUNT(*) FROM "observation_entity" WHERE "extractor" = ? AND "height" <= ?) AS "observations"`,
          [
            this.profile.scannerId,
            this.profile.anchor.blockHeight,
            this.profile.extractorId,
            this.profile.anchor.blockHeight,
          ],
        ),
        'ANCHOR_PROJECTION_READ',
      );
      if (
        preAnchorRows.length !== 1 ||
        preAnchorRows[0].blocks !== 0 ||
        preAnchorRows[0].observations !== 0
      )
        throw new SolanaStoreFault('PRE_ANCHOR_PROJECTION', 'identity');
      if (validateHistory) await this.validateHistoricalEvidence(runner, state);
      return state;
    });
    if (validateHistory) this.writerHistoryValidated = true;
    return snapshot;
  };

  /** Reject signatures already present in evidence, querying within bind limits. */
  private assertNoPreviouslyProvenSignatures = async (
    runner: QueryRunner,
    signatures: string[],
  ): Promise<void> => {
    // One bind parameter is used for genesis, leaving at most 899 signatures
    // under SQLite's conservative 900-parameter compatibility ceiling.
    const signaturesPerPage = EVIDENCE_QUERY_PARAMETER_LIMIT - 1;
    for (
      let offset = 0;
      offset < signatures.length;
      offset += signaturesPerPage
    ) {
      const page = signatures.slice(offset, offset + signaturesPerPage);
      if (page.length === 0) continue;
      const placeholders = page.map(() => '?').join(', ');
      const matches = rowsOf(
        await runner.query(
          `SELECT "sourceTxId" FROM "solana_observation_evidence"
           WHERE "genesisHash" = ? AND "sourceTxId" IN (${placeholders})
           LIMIT 1`,
          [this.profile.genesisHash, ...page],
        ),
        'EVIDENCE_SIGNATURE_READ',
      );
      if (matches.length > 0)
        throw new SolanaStoreFault('SIGNATURE_ALREADY_PROVEN', 'content');
    }
  };

  /** Reconcile stored evidence with observations, source blocks, and profile policy. */
  private validateHistoricalEvidence = async (
    runner: QueryRunner,
    state: SolanaScanState,
  ): Promise<void> => {
    const evidenceBlockMismatch = rowsOf(
      await runner.query(
        `SELECT e."sourceTxId"
         FROM "solana_observation_evidence" e
         LEFT JOIN "block_entity" b
           ON b."scanner" = e."scannerId"
          AND b."height" = e."sourceBlockHeight"
          AND b."hash" = e."sourceBlockId"
         WHERE (e."genesisHash" IS NOT ? OR e."scannerId" IS NOT ?
             OR e."extractorId" IS NOT ?
             OR e."sourceSlot" <= ? OR e."sourceSlot" > ?
             OR e."sourceBlockHeight" <= ? OR e."sourceBlockHeight" > ?
             OR e."block" IS NOT e."sourceBlockId"
             OR b."extra" IS NOT ('solana-slot-v1:' || e."sourceSlot")
             OR b."id" IS NULL OR b."status" IS NOT ?)
         LIMIT 1`,
        [
          this.profile.genesisHash,
          this.profile.scannerId,
          this.profile.extractorId,
          this.profile.anchor.slot,
          state.cursor.slot,
          this.profile.anchor.blockHeight,
          state.cursor.blockHeight,
          PROCEED,
        ],
      ),
      'EVIDENCE_BLOCK_RECONCILIATION',
    );
    if (evidenceBlockMismatch.length > 0)
      throw new SolanaStoreFault('EVIDENCE_BLOCK_MISMATCH', 'identity');

    const observationMismatch = rowsOf(
      await runner.query(
        `SELECT o."id"
         FROM "observation_entity" o
         LEFT JOIN "solana_observation_evidence" e
           ON e."genesisHash" = ?
          AND e."sourceTxId" = o."sourceTxId"
          AND e."scannerId" = ?
          AND e."extractorId" = ?
         WHERE (o."extractor" = ? OR e."sourceTxId" IS NOT NULL)
           AND (e."sourceTxId" IS NULL
             OR o."requestId" IS NOT e."requestId"
             OR o."extractor" IS NOT e."extractorId"
             OR o."sourceTxId" IS NOT e."sourceTxId"
             OR o."fromChain" IS NOT e."fromChain"
             OR o."toChain" IS NOT e."toChain"
             OR o."fromAddress" IS NOT e."fromAddress"
             OR o."toAddress" IS NOT e."toAddress"
             OR o."amount" IS NOT e."amount"
             OR o."bridgeFee" IS NOT e."bridgeFee"
             OR o."networkFee" IS NOT e."networkFee"
             OR o."sourceChainTokenId" IS NOT e."sourceChainTokenId"
             OR o."targetChainTokenId" IS NOT e."targetChainTokenId"
             OR o."sourceBlockId" IS NOT e."sourceBlockId"
             OR o."height" IS NOT e."sourceBlockHeight"
             OR o."block" IS NOT e."block"
             OR o."rawData" IS NOT e."rawData")
         LIMIT 1`,
        [
          this.profile.genesisHash,
          this.profile.scannerId,
          this.profile.extractorId,
          this.profile.extractorId,
        ],
      ),
      'OBSERVATION_EVIDENCE_RECONCILIATION',
    );
    if (observationMismatch.length > 0)
      throw new SolanaStoreFault('OBSERVATION_EVIDENCE_MISMATCH', 'identity');

    let afterSourceTxId = '';
    for (;;) {
      const page = rowsOf(
        await runner.query(
          `SELECT * FROM "solana_observation_evidence"
           WHERE "genesisHash" = ? AND "sourceTxId" > ?
           ORDER BY "sourceTxId" LIMIT ?`,
          [this.profile.genesisHash, afterSourceTxId, EVIDENCE_PAGE_SIZE],
        ),
        'EVIDENCE_PAGE_RECONCILIATION',
      );
      if (page.length === 0) break;
      for (const evidence of page) {
        if (
          typeof evidence.sourceTxId !== 'string' ||
          !isCanonicalBase58(evidence.sourceTxId, 64) ||
          typeof evidence.requestId !== 'string' ||
          !/^[0-9a-f]{64}$/.test(evidence.requestId) ||
          evidence.requestId !==
            Buffer.from(blake2b(evidence.sourceTxId, undefined, 32)).toString(
              'hex',
            ) ||
          !validText(evidence.fromChain, 30) ||
          !validText(evidence.toChain, 30) ||
          !validText(evidence.fromAddress) ||
          !validText(evidence.toAddress) ||
          !validAmount(evidence.amount) ||
          !validAmount(evidence.bridgeFee) ||
          !validAmount(evidence.networkFee) ||
          !validText(evidence.sourceChainTokenId) ||
          !validText(evidence.targetChainTokenId) ||
          !validText(evidence.sourceBlockId, 128) ||
          !validText(evidence.block, 128) ||
          !validText(evidence.rawData, 2048) ||
          typeof evidence.sourceSlot !== 'number' ||
          !Number.isSafeInteger(evidence.sourceSlot) ||
          evidence.sourceSlot <= this.profile.anchor.slot ||
          evidence.sourceSlot > state.cursor.slot ||
          typeof evidence.sourceBlockHeight !== 'number' ||
          !Number.isSafeInteger(evidence.sourceBlockHeight) ||
          evidence.sourceBlockHeight <= this.profile.anchor.blockHeight ||
          evidence.sourceBlockHeight > state.cursor.blockHeight ||
          !isCanonicalBase58(evidence.sourceBlockId, 32) ||
          evidence.block !== evidence.sourceBlockId ||
          typeof evidence.sourceChainTokenId !== 'string'
        )
          throw new SolanaStoreFault(
            'EVIDENCE_REQUEST_ID_MISMATCH',
            'identity',
          );
        const asset = this.profile.assets.find(
          (binding) => binding.assetId === evidence.sourceChainTokenId,
        );
        if (
          !asset ||
          evidence.fromChain !== SOLANA_CHAIN ||
          evidence.toChain !== this.profile.destinationChain ||
          evidence.targetChainTokenId !== asset.destinationTokenId ||
          evidence.bridgeFee !==
            expectedSolanaFee(
              asset.bridgeFee,
              asset.sourceDecimals,
              asset.destinationDecimals,
            ) ||
          evidence.networkFee !==
            expectedSolanaFee(
              asset.networkFee,
              asset.sourceDecimals,
              asset.destinationDecimals,
            )
        )
          throw new SolanaStoreFault('EVIDENCE_POLICY_MISMATCH', 'identity');
      }
      const last = page[page.length - 1].sourceTxId;
      if (typeof last !== 'string' || last <= afterSourceTxId)
        throw new SolanaStoreFault('EVIDENCE_PAGE_ORDER', 'identity');
      afterSourceTxId = last;
      if (page.length < EVIDENCE_PAGE_SIZE) break;
    }
  };

  /** Convert a database row into scan state after checking its field shapes. */
  private stateFromRow = (row: DbRow): SolanaScanState => {
    /** Check that a database value is a safe unsigned integer within its limit. */
    const isSafeUint = (value: unknown, max = MAX_SLOT): value is number =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= max;
    /** Check that a database value is non-empty text within its length limit. */
    const isText = (value: unknown, maxLength = 128): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maxLength;
    if (
      row.id !== 1 ||
      row.schemaVersion !== 1 ||
      !isText(row.genesisHash) ||
      !isText(row.scannerId) ||
      !isText(row.extractorId) ||
      !isText(row.configBinding, 64) ||
      !isSafeUint(row.anchorSlot) ||
      !isSafeUint(row.anchorBlockHeight, MAX_ROSEN_HEIGHT) ||
      !isText(row.anchorBlockhash) ||
      !isSafeUint(row.cursorSlot) ||
      !isSafeUint(row.cursorBlockHeight, MAX_ROSEN_HEIGHT) ||
      !isText(row.cursorBlockhash) ||
      !isSafeUint(row.scannedThroughSlot) ||
      !isSafeUint(row.revision) ||
      !(row.holdCode === null || isText(row.holdCode, 64))
    )
      throw new SolanaStoreFault('STATE_SCHEMA', 'identity');
    return {
      schemaVersion: 1,
      genesisHash: row.genesisHash,
      scannerId: row.scannerId,
      extractorId: row.extractorId,
      configBinding: row.configBinding,
      anchor: {
        slot: row.anchorSlot,
        blockHeight: row.anchorBlockHeight,
        blockhash: row.anchorBlockhash,
      },
      cursor: {
        slot: row.cursorSlot,
        blockHeight: row.cursorBlockHeight,
        blockhash: row.cursorBlockhash,
      },
      scannedThroughSlot: row.scannedThroughSlot,
      revision: row.revision,
      holdCode: row.holdCode,
    };
  };

  /** Ensure persisted state identity and cursor fields match the scan profile. */
  private validateStateIdentity = (state: SolanaScanState): void => {
    if (
      state.genesisHash !== this.profile.genesisHash ||
      state.scannerId !== this.profile.scannerId ||
      state.extractorId !== this.profile.extractorId ||
      state.configBinding !== this.configBinding ||
      !sameRef(state.anchor, this.profile.anchor) ||
      state.cursor.slot < state.anchor.slot ||
      state.cursor.blockHeight < state.anchor.blockHeight ||
      state.scannedThroughSlot < state.cursor.slot ||
      (state.holdCode !== null && !/^[A-Z0-9_-]{1,64}$/.test(state.holdCode))
    )
      throw new SolanaStoreFault('CONFIG_IDENTITY', 'identity');
  };

  /** Require the supplied anchor block fields to match the configured profile. */
  private validateAnchorBlock = (block: SolanaRpcBlock): void => {
    if (
      block.commitment !== 'finalized' ||
      block.slot !== this.profile.anchor.slot ||
      block.blockHeight !== this.profile.anchor.blockHeight ||
      block.blockhash !== this.profile.anchor.blockhash ||
      block.parentSlot >= block.slot ||
      !Number.isSafeInteger(block.blockTime) ||
      block.blockTime < 0 ||
      block.blockTime > MAX_ROSEN_HEIGHT
    )
      throw new SolanaStoreFault('ANCHOR_MISMATCH', 'identity');
  };

  /** Check batch bounds, block linkage, signatures, observations, and next cursor. */
  private validateBatch = (
    state: SolanaScanState,
    next: SolanaScanStateUpdate,
    blocks: SolanaScannedBlock[],
  ): void => {
    if (
      !Array.isArray(blocks) ||
      blocks.length > MAX_BLOCKS_PER_BATCH ||
      !Number.isSafeInteger(next.scannedThroughSlot) ||
      next.scannedThroughSlot <= state.scannedThroughSlot ||
      next.scannedThroughSlot > MAX_SLOT
    )
      throw new SolanaStoreFault('BATCH_BOUND', 'content');
    let cursor = state.cursor;
    let transactionCount = 0;
    let observationCount = 0;
    const seenSignatures = new Set<string>();
    for (const scanned of blocks) {
      const block = scanned.block;
      if (
        block.commitment !== 'finalized' ||
        !Number.isSafeInteger(block.slot) ||
        block.slot <= cursor.slot ||
        block.slot > next.scannedThroughSlot ||
        !Number.isSafeInteger(block.blockHeight) ||
        block.blockHeight !== cursor.blockHeight + 1 ||
        block.blockHeight > MAX_ROSEN_HEIGHT ||
        block.parentSlot !== cursor.slot ||
        block.previousBlockhash !== cursor.blockhash ||
        !validText(block.blockhash, 128) ||
        !Number.isSafeInteger(block.blockTime) ||
        block.blockTime < 0 ||
        block.blockTime > MAX_ROSEN_HEIGHT ||
        !Array.isArray(block.transactions) ||
        !Array.isArray(scanned.deposits)
      )
        throw new SolanaStoreFault('BLOCK_BATCH_BINDING', 'content');
      transactionCount += block.transactions.length;
      if (transactionCount > MAX_TRANSACTION_REFERENCES_PER_BATCH)
        throw new SolanaStoreFault('TRANSACTION_BATCH_BOUND', 'content');
      for (const [index, transaction] of block.transactions.entries()) {
        if (
          transaction.transactionIndex !== index ||
          !isCanonicalBase58(transaction.signature, 64) ||
          seenSignatures.has(transaction.signature)
        )
          throw new SolanaStoreFault('DUPLICATE_TRANSACTION', 'content');
        seenSignatures.add(transaction.signature);
      }
      const blockSignatures = new Set(
        block.transactions.map((transaction) => transaction.signature),
      );
      for (const candidate of scanned.deposits) {
        observationCount++;
        if (
          observationCount > MAX_OBSERVATIONS_PER_BATCH ||
          !blockSignatures.has(candidate.signature) ||
          !isCanonicalBase58(candidate.signature, 64) ||
          !candidate.data ||
          !candidate.context
        )
          throw new SolanaStoreFault('OBSERVATION_BATCH_BINDING', 'content');
      }
      cursor = {
        slot: block.slot,
        blockHeight: block.blockHeight,
        blockhash: block.blockhash,
      };
    }
    if (
      blocks.length === 0
        ? !sameRef(next.cursor, state.cursor)
        : !sameRef(next.cursor, cursor)
    )
      throw new SolanaStoreFault('NEXT_CURSOR_BINDING', 'content');
  };

  /** Insert a pending scanner block row with its slot metadata. */
  private insertBlock = async (
    runner: QueryRunner,
    block: Omit<SolanaRpcBlock, 'rawResponse'>,
  ): Promise<void> => {
    const date = new Date(block.blockTime * 1000);
    const result = await runner.manager.getRepository(BlockEntity).insert({
      height: block.blockHeight,
      hash: block.blockhash,
      parentHash: block.previousBlockhash,
      extra: solanaSlotMetadata(block.slot),
      status: BLOCK_PENDING,
      scanner: this.profile.scannerId,
      timestamp: block.blockTime,
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    });
    if (!result.identifiers || result.identifiers.length !== 1)
      throw new SolanaStoreFault('BLOCK_INSERT', 'content');
  };

  /** Mark the matching pending scanner block row as proceed. */
  private markBlockProceed = async (
    runner: QueryRunner,
    block: Omit<SolanaRpcBlock, 'rawResponse'>,
  ): Promise<void> => {
    const result = await runner.manager.getRepository(BlockEntity).update(
      {
        scanner: this.profile.scannerId,
        height: block.blockHeight,
        hash: block.blockhash,
        status: BLOCK_PENDING,
      },
      { status: PROCEED },
    );
    if (result.affected !== 1)
      throw new SolanaStoreFault('BLOCK_PROJECTION', 'content');
  };

  /** Validate a deposit candidate, then insert its observation and evidence rows. */
  private insertObservation = async (
    runner: QueryRunner,
    block: Omit<SolanaRpcBlock, 'rawResponse'>,
    candidate: SolanaScannedBlock['deposits'][number],
  ): Promise<void> => {
    const context = candidate.context;
    const data = candidate.data;
    const asset = this.profile.assets.find(
      (binding) => binding.assetId === data.sourceChainTokenId,
    );
    if (
      !asset ||
      asset.destinationTokenId !== data.targetChainTokenId ||
      data.toChain !== this.profile.destinationChain ||
      data.sourceTxId !== candidate.signature ||
      context.clusterGenesisHash !== this.profile.genesisHash ||
      context.sourceTxId !== candidate.signature ||
      context.sourceSlot !== block.slot ||
      context.sourceBlockhash !== block.blockhash ||
      !validText(data.toAddress) ||
      !validText(data.fromAddress) ||
      !validAmount(data.amount) ||
      !validAmount(data.bridgeFee) ||
      !validAmount(data.networkFee) ||
      !validText(data.rawData, 2048) ||
      data.bridgeFee !==
        expectedSolanaFee(
          asset.bridgeFee,
          asset.sourceDecimals,
          asset.destinationDecimals,
        ) ||
      data.networkFee !==
        expectedSolanaFee(
          asset.networkFee,
          asset.sourceDecimals,
          asset.destinationDecimals,
        )
    )
      throw new SolanaStoreFault('OBSERVATION_BINDING', 'content');

    const event = {
      sourceTxId: candidate.signature,
      fromChain: SOLANA_CHAIN,
      toChain: data.toChain,
      fromAddress: data.fromAddress,
      toAddress: data.toAddress,
      amount: data.amount,
      bridgeFee: data.bridgeFee,
      networkFee: data.networkFee,
      sourceChainTokenId: data.sourceChainTokenId,
      targetChainTokenId: data.targetChainTokenId,
      sourceBlockId: block.blockhash,
      height: block.blockHeight,
    };
    const requestId = Buffer.from(
      blake2b(candidate.signature, undefined, 32),
    ).toString('hex');
    const observation = {
      ...event,
      requestId,
      block: block.blockhash,
      extractor: this.profile.extractorId,
      rawData: data.rawData,
    };
    const evidence = {
      genesisHash: this.profile.genesisHash,
      sourceTxId: candidate.signature,
      scannerId: this.profile.scannerId,
      extractorId: this.profile.extractorId,
      requestId,
      sourceSlot: block.slot,
      sourceBlockHeight: block.blockHeight,
      sourceBlockId: block.blockhash,
      fromChain: event.fromChain,
      toChain: event.toChain,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
      amount: event.amount,
      bridgeFee: event.bridgeFee,
      networkFee: event.networkFee,
      sourceChainTokenId: event.sourceChainTokenId,
      targetChainTokenId: event.targetChainTokenId,
      block: observation.block,
      rawData: observation.rawData,
    };
    await runner.manager
      .getRepository(SolanaObservationEvidenceEntity)
      .insert(evidence);
    await runner.manager.getRepository(ObservationEntity).insert(observation);
  };

  /** Resolve an uncertain batch commit by reading durable state without retrying. */
  private resolveInstallCommit = async (
    before: SolanaScanState,
    expectedRevision: number,
    next: SolanaScanStateUpdate,
    blocks: SolanaScannedBlock[],
  ): Promise<SolanaScanState> => {
    const resolved = await this.readSnapshot();
    if (
      resolved &&
      resolved.revision === expectedRevision + 1 &&
      resolved.scannedThroughSlot === next.scannedThroughSlot &&
      sameRef(resolved.cursor, next.cursor)
    )
      return resolved;
    if (
      resolved &&
      resolved.revision === expectedRevision &&
      resolved.scannedThroughSlot === before.scannedThroughSlot &&
      sameRef(resolved.cursor, before.cursor)
    )
      throw new SolanaStoreFault('COMMIT_NOT_APPLIED', 'unavailable');
    // A newer writer may have advanced after this commit. Do not retry it blindly.
    if (
      resolved &&
      resolved.revision > expectedRevision + 1 &&
      blocks.length > 0
    )
      throw new SolanaStoreFault(
        'COMMIT_ADVANCED_REQUIRES_RECONCILIATION',
        'identity',
      );
    throw new SolanaStoreFault('COMMIT_OUTCOME_UNKNOWN', 'unavailable');
  };
}
