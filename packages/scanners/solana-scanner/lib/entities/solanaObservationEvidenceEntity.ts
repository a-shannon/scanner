import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
} from '@rosen-bridge/extended-typeorm';

@Entity('solana_observation_evidence')
@Index('IDX_solana_evidence_request_extractor', ['requestId', 'extractorId'])
export class SolanaObservationEvidenceEntity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  genesisHash: string;

  @PrimaryColumn({ type: 'varchar', length: 90 })
  sourceTxId: string;

  @Column({ type: 'varchar' })
  scannerId: string;

  @Column({ type: 'varchar' })
  extractorId: string;

  @Column({ type: 'varchar', length: 64 })
  requestId: string;

  @Column({ type: 'int' })
  sourceSlot: number;

  @Column({ type: 'int' })
  sourceBlockHeight: number;

  @Column({ type: 'varchar', length: 128 })
  sourceBlockId: string;

  @Column({ type: 'varchar', length: 30 })
  fromChain: string;

  @Column({ type: 'varchar', length: 30 })
  toChain: string;

  @Column({ type: 'varchar' })
  fromAddress: string;

  @Column({ type: 'varchar' })
  toAddress: string;

  @Column({ type: 'varchar' })
  amount: string;

  @Column({ type: 'varchar' })
  bridgeFee: string;

  @Column({ type: 'varchar' })
  networkFee: string;

  @Column({ type: 'varchar' })
  sourceChainTokenId: string;

  @Column({ type: 'varchar' })
  targetChainTokenId: string;

  @Column({ type: 'varchar', length: 128 })
  block: string;

  @Column({ type: 'varchar', length: 2048 })
  rawData: string;
}
