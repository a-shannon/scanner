import {
  SolanaRpcBlock,
  SolanaScanState,
  SolanaScanStateUpdate,
  SolanaScannedBlock,
} from '../types';

export interface SolanaScanStorePort {
  getProfileBinding(): string;
  withExclusiveScan<T>(operation: () => Promise<T>): Promise<T>;
  readState(): Promise<SolanaScanState | undefined>;
  initialize(anchorBlock: SolanaRpcBlock): Promise<SolanaScanState>;
  installBatch(
    expectedRevision: number,
    next: SolanaScanStateUpdate,
    blocks: SolanaScannedBlock[],
  ): Promise<SolanaScanState>;
  persistHold(expectedRevision: number, code: string): Promise<void>;
}
