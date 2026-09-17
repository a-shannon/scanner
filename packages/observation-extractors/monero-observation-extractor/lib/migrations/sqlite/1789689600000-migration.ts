import {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

export class MoneroCandidate1789689600000 implements MigrationInterface {
  name = 'MoneroCandidate1789689600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "monero_candidate_entity" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "extractorId" varchar(128) NOT NULL,
        "scannerId" varchar(128) NOT NULL,
        "scope" varchar(64) NOT NULL,
        "txId" varchar(64) NOT NULL,
        "transactionHex" text NOT NULL,
        "sourceBlockId" varchar(64) NOT NULL,
        "block" varchar(64) NOT NULL,
        "sourceHeight" integer NOT NULL,
        "state" varchar(16) NOT NULL,
        "revision" integer NOT NULL DEFAULT (0),
        "leaseToken" varchar(64),
        "leaseExpiresAt" integer,
        "nextAttemptAt" integer,
        "capturedAt" integer NOT NULL,
        "updatedAt" integer NOT NULL,
        "observationRequestId" varchar(64)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_monero_candidate_identity"
      ON "monero_candidate_entity"
        ("extractorId", "scope", "txId", "sourceBlockId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_monero_candidate_due"
      ON "monero_candidate_entity"
        ("extractorId", "scope", "state", "nextAttemptAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_monero_candidate_source"
      ON "monero_candidate_entity"
        ("extractorId", "scope", "sourceBlockId")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "UQ_monero_candidate_identity"');
    await queryRunner.query('DROP INDEX "IDX_monero_candidate_source"');
    await queryRunner.query('DROP INDEX "IDX_monero_candidate_due"');
    await queryRunner.query('DROP TABLE "monero_candidate_entity"');
  }
}
