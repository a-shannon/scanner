import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from '@rosen-bridge/extended-typeorm';

export type MoneroCandidateState =
  | 'pending'
  | 'accepted'
  | 'expired'
  | 'orphaned';

@Entity('monero_candidate_entity')
@Index(
  'UQ_monero_candidate_identity',
  ['extractorId', 'scope', 'txId', 'sourceBlockId'],
  { unique: true },
)
@Index('IDX_monero_candidate_due', [
  'extractorId',
  'scope',
  'state',
  'nextAttemptAt',
])
@Index('IDX_monero_candidate_source', ['extractorId', 'scope', 'sourceBlockId'])
export class MoneroCandidateEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 128 })
  extractorId: string;

  @Column({ type: 'varchar', length: 128 })
  scannerId: string;

  @Column({ type: 'varchar', length: 64 })
  scope: string;

  @Column({ type: 'varchar', length: 64 })
  txId: string;

  @Column({ type: 'text' })
  transactionHex: string;

  @Column({ type: 'varchar', length: 64 })
  sourceBlockId: string;

  /** Compatibility column consumed by AbstractExtractor used-block queries. */
  @Column({ type: 'varchar', length: 64 })
  block: string;

  @Column({ type: 'int' })
  sourceHeight: number;

  @Column({ type: 'varchar', length: 16 })
  state: MoneroCandidateState;

  @Column({ type: 'int', default: 0 })
  revision: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  leaseToken: string | null;

  @Column({ type: 'integer', nullable: true })
  leaseExpiresAt: number | null;

  @Column({ type: 'integer', nullable: true })
  nextAttemptAt: number | null;

  @Column({ type: 'integer' })
  capturedAt: number;

  @Column({ type: 'integer' })
  updatedAt: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  observationRequestId: string | null;
}
