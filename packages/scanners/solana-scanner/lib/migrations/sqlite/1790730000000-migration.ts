import {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

export class migration1790730000000 implements MigrationInterface {
  name = 'migration1790730000000';

  /** Create the Solana cursor and observation evidence tables and request index. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "solana_scan_state" (
        "id" integer NOT NULL PRIMARY KEY CHECK ("id" = 1),
        "schemaVersion" integer NOT NULL CHECK ("schemaVersion" = 1),
        "genesisHash" varchar(128) NOT NULL,
        "scannerId" varchar(128) NOT NULL,
        "extractorId" varchar(128) NOT NULL,
        "configBinding" varchar(64) NOT NULL CHECK (length("configBinding") = 64),
        "anchorSlot" integer NOT NULL CHECK ("anchorSlot" BETWEEN 0 AND 9007199254740991),
        "anchorBlockHeight" integer NOT NULL CHECK ("anchorBlockHeight" BETWEEN 0 AND 2147483647),
        "anchorBlockhash" varchar(128) NOT NULL,
        "cursorSlot" integer NOT NULL CHECK ("cursorSlot" BETWEEN 0 AND 9007199254740991),
        "cursorBlockHeight" integer NOT NULL CHECK ("cursorBlockHeight" BETWEEN 0 AND 2147483647),
        "cursorBlockhash" varchar(128) NOT NULL,
        "scannedThroughSlot" integer NOT NULL CHECK ("scannedThroughSlot" BETWEEN 0 AND 9007199254740991),
        "revision" integer NOT NULL CHECK ("revision" BETWEEN 0 AND 9007199254740991),
        "holdCode" varchar(64)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "solana_observation_evidence" (
        "genesisHash" varchar(128) NOT NULL,
        "sourceTxId" varchar(90) NOT NULL CHECK (length("sourceTxId") BETWEEN 1 AND 90),
        "scannerId" varchar(128) NOT NULL,
        "extractorId" varchar(128) NOT NULL,
        "requestId" varchar(64) NOT NULL CHECK (length("requestId") = 64),
        "sourceSlot" integer NOT NULL CHECK ("sourceSlot" BETWEEN 0 AND 9007199254740991),
        "sourceBlockHeight" integer NOT NULL CHECK ("sourceBlockHeight" BETWEEN 0 AND 2147483647),
        "sourceBlockId" varchar(128) NOT NULL,
        "fromChain" varchar(30) NOT NULL,
        "toChain" varchar(30) NOT NULL,
        "fromAddress" varchar NOT NULL,
        "toAddress" varchar NOT NULL,
        "amount" varchar NOT NULL CHECK (length("amount") BETWEEN 1 AND 39),
        "bridgeFee" varchar NOT NULL CHECK (length("bridgeFee") BETWEEN 1 AND 39),
        "networkFee" varchar NOT NULL CHECK (length("networkFee") BETWEEN 1 AND 39),
        "sourceChainTokenId" varchar NOT NULL,
        "targetChainTokenId" varchar NOT NULL,
        "block" varchar(128) NOT NULL,
        "rawData" varchar(2048) NOT NULL CHECK (length("rawData") BETWEEN 1 AND 2048),
        PRIMARY KEY ("genesisHash", "sourceTxId")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_solana_evidence_request_extractor"
      ON "solana_observation_evidence" ("requestId", "extractorId")
    `);
  }

  /** Drop the Solana tables and index only when both tables contain no rows. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT
        (SELECT COUNT(*) FROM "solana_scan_state") AS "stateCount",
        (SELECT COUNT(*) FROM "solana_observation_evidence") AS "evidenceCount"
    `)) as Array<{ stateCount: number; evidenceCount: number }>;
    if (
      rows.length !== 1 ||
      rows[0].stateCount !== 0 ||
      rows[0].evidenceCount !== 0
    )
      throw new Error('SOLANA_MIGRATION_DOWN_WITH_DATA');
    await queryRunner.query(
      'DROP INDEX "IDX_solana_evidence_request_extractor"',
    );
    await queryRunner.query('DROP TABLE "solana_observation_evidence"');
    await queryRunner.query('DROP TABLE "solana_scan_state"');
  }
}
