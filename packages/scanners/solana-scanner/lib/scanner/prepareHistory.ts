import { JsonBigIntFactory } from '@rosen-bridge/json-bigint';

import { SolanaScannerFault } from '../errors';
import { SolanaBlockHistoryRequest, SolanaHistorySource } from '../types';

const strictJson = JsonBigIntFactory({ strict: true, storeAsString: true });
/** Narrow a non-null, non-array object to a record for history envelope checks. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Bounds and binds fixture/history data; provenance authentication belongs to L5. */
export const prepareSolanaHistory = async (
  source: SolanaHistorySource | undefined,
  request: SolanaBlockHistoryRequest,
  maxBytes: number,
): Promise<{ history: ReadonlyMap<string, unknown>; bytes: number }> => {
  const history = new Map<string, unknown>();
  if (!source) return { history, bytes: 0 };
  const immutableRequest = Object.freeze({
    ...request,
    signatures: Object.freeze([...request.signatures]),
  });
  const response = await source.getBlockHistory(immutableRequest, {
    maxEntries: request.signatures.length,
    maxBytes,
  });
  if (
    !isRecord(response) ||
    response.genesisHash !== request.genesisHash ||
    response.slot !== request.slot ||
    response.blockhash !== request.blockhash ||
    !Array.isArray(response.entries) ||
    response.entries.length > request.signatures.length
  )
    throw new SolanaScannerFault('HISTORY_ENVELOPE');
  const allowed = new Set(request.signatures);
  let bytes = 0;
  for (const entry of response.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.signature !== 'string' ||
      !allowed.has(entry.signature) ||
      history.has(entry.signature) ||
      typeof entry.serializedHistory !== 'string'
    )
      throw new SolanaScannerFault('HISTORY_ENTRY');
    bytes +=
      Buffer.byteLength(entry.serializedHistory, 'utf8') +
      Buffer.byteLength(entry.signature, 'utf8');
    if (bytes > maxBytes) throw new SolanaScannerFault('HISTORY_BYTES_BOUND');
    let parsed: unknown;
    try {
      // Reject duplicate keys. Amounts remain decimal strings; only canonical,
      // safe integer JSON numbers (slot/decimals) are accepted in this port.
      strictJson.parse(entry.serializedHistory);
      parsed = JSON.parse(
        entry.serializedHistory,
        (_key: string, value: unknown, context?: { source?: string }) => {
          if (typeof value !== 'number') return value;
          if (
            !Number.isSafeInteger(value) ||
            value < 0 ||
            !context?.source ||
            !/^(0|[1-9][0-9]*)$/.test(context.source)
          )
            throw new Error('HISTORY_NUMBER');
          return value;
        },
      );
    } catch {
      throw new SolanaScannerFault('HISTORY_JSON');
    }
    if (
      !isRecord(parsed) ||
      parsed.clusterGenesisHash !== request.genesisHash ||
      parsed.slot !== request.slot ||
      parsed.sourceTxId !== entry.signature
    )
      throw new SolanaScannerFault('HISTORY_BINDING');
    history.set(entry.signature, parsed);
  }
  return { history, bytes };
};
