import {
  Column,
  Entity,
  MigrationInterface,
  PrimaryColumn,
  QueryRunner,
  Table,
} from '@rosen-bridge/extended-typeorm';

/** Durable identity and stop state for a single-writer C-Chain scanner. */
@Entity('avalanche_safety_state')
export class AvalancheSafetyState {
  @PrimaryColumn({ type: 'varchar' })
  scanner: string;

  @Column({ type: 'varchar' })
  chainId: string;

  @Column({ type: 'varchar' })
  sourceId: string;

  @Column({ type: 'varchar' })
  policy: string;

  @Column({ type: 'int' })
  initialHeight: number;

  @Column({ type: 'int', nullable: true })
  finalizedHeight: number | null;

  @Column({ type: 'varchar', nullable: true })
  finalizedHash: string | null;

  @Column({ type: 'varchar', nullable: true })
  holdReason: string | null;
}

/** Register alongside the scanner migrations for SQLite or PostgreSQL. */
export class AvalancheSafetyState1790769600000 implements MigrationInterface {
  /** Creates the scanner identity, finalized frontier and hold-state table. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'avalanche_safety_state',
        columns: [
          { name: 'scanner', type: 'varchar', isPrimary: true },
          { name: 'chainId', type: 'varchar' },
          { name: 'sourceId', type: 'varchar' },
          { name: 'policy', type: 'varchar' },
          { name: 'initialHeight', type: 'int' },
          { name: 'finalizedHeight', type: 'int', isNullable: true },
          { name: 'finalizedHash', type: 'varchar', isNullable: true },
          { name: 'holdReason', type: 'varchar', isNullable: true },
        ],
      }),
    );
  }

  /** Removes only an empty safety table, preserving any recorded scanner state. */
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.manager.count(AvalancheSafetyState);
    if (rows !== 0)
      throw new Error('Cannot remove a populated Avalanche safety state');
    await runner.dropTable('avalanche_safety_state');
  }
}
