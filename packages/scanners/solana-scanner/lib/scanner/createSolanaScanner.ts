import { createSolanaScanProfile, SolanaScanIdentity } from '../profile';
import { SqliteSolanaScanStore } from '../store/sqliteSolanaScanStore';
import { SolanaBlockProjector, SolanaHistorySource, SolanaRpc } from '../types';
import {
  SolanaFinalizedScanner,
  SolanaFinalizedScannerBounds,
} from './solanaFinalizedScanner';

/** Migrations remain explicit. The concrete projector owns the effective policy. */
export const createSolanaScanner = (config: {
  rpc: SolanaRpc;
  projector: SolanaBlockProjector;
  identity: SolanaScanIdentity;
  database: string;
  historySource?: SolanaHistorySource;
  bounds?: SolanaFinalizedScannerBounds;
}): { scanner: SolanaFinalizedScanner; store: SqliteSolanaScanStore } => {
  const profile = createSolanaScanProfile(
    config.projector.getResolvedProfile(),
    config.identity,
  );
  const store = new SqliteSolanaScanStore(profile, config.database);
  const scanner = new SolanaFinalizedScanner({
    rpc: config.rpc,
    projector: config.projector,
    historySource: config.historySource,
    bounds: config.bounds,
    profile,
    store,
  });
  return { scanner, store };
};
