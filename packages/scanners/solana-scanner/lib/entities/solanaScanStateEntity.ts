import { Column, Entity, PrimaryColumn } from '@rosen-bridge/extended-typeorm';

@Entity('solana_scan_state')
export class SolanaScanStateEntity {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @Column({ type: 'int' })
  schemaVersion: number;

  @Column({ type: 'varchar' })
  genesisHash: string;

  @Column({ type: 'varchar' })
  scannerId: string;

  @Column({ type: 'varchar' })
  extractorId: string;

  @Column({ type: 'varchar', length: 64 })
  configBinding: string;

  @Column({ type: 'int' })
  anchorSlot: number;

  @Column({ type: 'int' })
  anchorBlockHeight: number;

  @Column({ type: 'varchar' })
  anchorBlockhash: string;

  @Column({ type: 'int' })
  cursorSlot: number;

  @Column({ type: 'int' })
  cursorBlockHeight: number;

  @Column({ type: 'varchar' })
  cursorBlockhash: string;

  @Column({ type: 'int' })
  scannedThroughSlot: number;

  @Column({ type: 'int' })
  revision: number;

  @Column({ type: 'varchar', nullable: true })
  holdCode: string | null;
}
