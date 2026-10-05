import { JsonBigIntFactory } from '@rosen-bridge/json-bigint';

import { SolanaRpcUnavailableError, SolanaScannerFault } from '../errors';
import { SolanaFinalizedHead, SolanaRpc, SolanaRpcBlock } from '../types';
import { isCanonicalBase58 } from '../validation/base58';

const MAX_BLOCK_HEIGHT = 2_147_483_647;
const MAX_SLOT_RANGE = 4096;
const MAX_BLOCK_TRANSACTIONS = 8192;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const defaultResponseBytes = 32 * 1024 * 1024;
const strictJson = JsonBigIntFactory({ strict: true, storeAsString: true });
const REQUIRED_HISTORY_CODES = new Set([
  -32001, -32007, -32009, -32011, -32021,
]);

class SourceNumber {
  /** Preserve the original decimal token text for precise JSON-number checks. */
  constructor(readonly source: string) {}
}

/** Read a safe signed-integer RPC code from a preserved JSON-number token. */
const readRpcCode = (value: unknown): number | undefined => {
  if (
    !(value instanceof SourceNumber) ||
    !/^-?(0|[1-9][0-9]*)$/.test(value.source)
  )
    return undefined;
  const parsed = BigInt(value.source);
  if (
    parsed < BigInt(Number.MIN_SAFE_INTEGER) ||
    parsed > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return undefined;
  return Number(parsed);
};

interface RpcResponse {
  body: string;
  result: unknown;
}

/** Narrow a non-null, non-array object to a string-keyed record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse an unsigned JSON-number token if it fits JavaScript's safe integer range. */
const readUint = (value: unknown, code: string): number => {
  if (
    !(value instanceof SourceNumber) ||
    !/^(0|[1-9][0-9]*)$/.test(value.source)
  )
    throw new SolanaScannerFault(code);
  const integer = BigInt(value.source);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SolanaScannerFault(code);
  return Number(integer);
};

/** Validate and return a canonical Base58 32-byte hash. */
const requireHash = (value: unknown, code: string): string => {
  if (!isCanonicalBase58(value, 32)) throw new SolanaScannerFault(code);
  return value as string;
};

/** Strictly parse a JSON-RPC response, match its ID, and classify its result or error. */
const parseResponse = (
  body: string,
  expectedId: string,
  method: string,
): unknown => {
  try {
    // The strict pass rejects duplicate keys before the source-token parse.
    strictJson.parse(body);
    const response = JSON.parse(
      body,
      (_key: string, value: unknown, context?: { source?: string }) => {
        if (typeof value !== 'number') return value;
        if (typeof context?.source !== 'string')
          throw new Error('JSON number source unavailable');
        return new SourceNumber(context.source);
      },
    );
    if (
      !isRecord(response) ||
      response.jsonrpc !== '2.0' ||
      response.id !== expectedId
    )
      throw new SolanaScannerFault('RPC_ENVELOPE');
    if (Object.hasOwn(response, 'error')) {
      const rpcError = response.error;
      const rpcCode = isRecord(rpcError)
        ? readRpcCode(rpcError.code)
        : undefined;
      if (method === 'getBlock' && rpcCode !== undefined) {
        if (REQUIRED_HISTORY_CODES.has(rpcCode))
          throw new SolanaScannerFault('HISTORY_GAP', method, rpcCode);
        if (rpcCode === -32015)
          throw new SolanaScannerFault(
            'BLOCK_VERSION_UNSUPPORTED',
            method,
            rpcCode,
          );
      }
      throw new SolanaRpcUnavailableError('RPC_METHOD_ERROR', method, rpcCode);
    }
    if (!Object.hasOwn(response, 'result'))
      throw new SolanaScannerFault('RPC_RESULT_MISSING');
    return response.result;
  } catch (error) {
    if (
      error instanceof SolanaScannerFault ||
      error instanceof SolanaRpcUnavailableError
    )
      throw error;
    throw new SolanaRpcUnavailableError('RPC_JSON');
  }
};

/** Reject oversized response bodies and decode accepted bytes as strict UTF-8. */
const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(maximumBytes))
      throw new SolanaRpcUnavailableError('RPC_RESPONSE_BOUND');
  }
  if (!response.body) throw new SolanaRpcUnavailableError('RPC_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new SolanaRpcUnavailableError('RPC_RESPONSE_BOUND');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SolanaRpcUnavailableError('RPC_UTF8');
  }
};

export interface HttpSolanaRpcConfig {
  endpoint: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTransactionsPerBlock?: number;
  fetcher?: typeof fetch;
}

/** Bounded HTTP JSON-RPC adapter; it never logs the endpoint or response body. */
export class HttpSolanaRpc implements SolanaRpc {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxTransactionsPerBlock: number;
  private readonly fetcher: typeof fetch;
  private requestNumber = 0;

  /** Validate endpoint settings and initialize the adapter's request bounds. */
  constructor(config: HttpSolanaRpcConfig) {
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      throw new Error('INVALID_SOLANA_RPC_ENDPOINT');
    }
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username.length > 0 ||
      endpoint.password.length > 0
    )
      throw new Error('INVALID_SOLANA_RPC_ENDPOINT');
    this.endpoint = endpoint;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.maxResponseBytes = config.maxResponseBytes ?? defaultResponseBytes;
    this.maxTransactionsPerBlock = config.maxTransactionsPerBlock ?? 4096;
    this.fetcher = config.fetcher ?? fetch;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1000 ||
      this.timeoutMs > 60_000 ||
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1024 ||
      this.maxResponseBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(this.maxTransactionsPerBlock) ||
      this.maxTransactionsPerBlock < 1 ||
      this.maxTransactionsPerBlock > MAX_BLOCK_TRANSACTIONS
    )
      throw new Error('INVALID_SOLANA_RPC_BOUNDS');
  }

  /** Send one bounded JSON-RPC POST and map HTTP, transport, timeout, and parse failures. */
  private request = async (
    method: string,
    params: unknown[],
  ): Promise<RpcResponse> => {
    if (this.requestNumber >= Number.MAX_SAFE_INTEGER)
      throw new SolanaRpcUnavailableError('RPC_ID_EXHAUSTED');
    const id = `solana-${++this.requestNumber}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new SolanaRpcUnavailableError('RPC_HTTP_STATUS');
      const body = await readBoundedBody(response, this.maxResponseBytes);
      const result = parseResponse(body, id, method);
      return { body, result };
    } catch (error) {
      if (
        error instanceof SolanaRpcUnavailableError ||
        error instanceof SolanaScannerFault
      )
        throw error;
      if (controller.signal.aborted)
        throw new SolanaRpcUnavailableError('RPC_TIMEOUT');
      throw new SolanaRpcUnavailableError('RPC_TRANSPORT');
    } finally {
      clearTimeout(timeout);
    }
  };

  /** Fetch and validate the RPC-reported genesis hash. */
  getGenesisHash = async (): Promise<string> => {
    const { result } = await this.request('getGenesisHash', []);
    return requireHash(result, 'GENESIS_SCHEMA');
  };

  /** Fetch the first available block slot as a safe unsigned integer. */
  getFirstAvailableBlock = async (): Promise<number> => {
    const { result } = await this.request('getFirstAvailableBlock', []);
    return readUint(result, 'RETENTION_SCHEMA');
  };

  /** Read the slot using the RPC's requested finalized commitment. */
  private getFinalizedSlot = async (): Promise<number> => {
    const { result } = await this.request('getSlot', [
      { commitment: 'finalized' },
    ]);
    return readUint(result, 'HEAD_SCHEMA');
  };

  /** List ordered block slots for a bounded inclusive range at finalized commitment. */
  getBlocks = async (
    start: number,
    end: number,
    config: { commitment: 'finalized' },
  ): Promise<number[]> => {
    if (
      config.commitment !== 'finalized' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end - start + 1 > MAX_SLOT_RANGE
    )
      throw new SolanaScannerFault('PAGE_RANGE');
    const { result } = await this.request('getBlocks', [
      start,
      end,
      { commitment: 'finalized' },
    ]);
    if (!Array.isArray(result) || result.length > end - start + 1)
      throw new SolanaScannerFault('PAGE_BOUND');
    const slots = result.map((slot) => readUint(slot, 'PAGE_SCHEMA'));
    let previous = start - 1;
    for (const slot of slots) {
      if (slot < start || slot > end || slot <= previous)
        throw new SolanaScannerFault('PAGE_ORDER');
      previous = slot;
    }
    return slots;
  };

  /** Fetch a block with the finalized commitment parameter and validate its fields and signatures. */
  getBlock = async (
    slot: number,
    config: {
      commitment: 'finalized';
      maxSupportedTransactionVersion: 0;
    },
  ): Promise<SolanaRpcBlock | null> => {
    if (
      config.commitment !== 'finalized' ||
      config.maxSupportedTransactionVersion !== 0 ||
      !Number.isSafeInteger(slot) ||
      slot < 0
    )
      throw new SolanaScannerFault('BLOCK_REQUEST_POLICY');
    const { body, result } = await this.request('getBlock', [
      slot,
      {
        commitment: 'finalized',
        encoding: 'json',
        transactionDetails: 'full',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (result === null)
      throw new SolanaScannerFault('HISTORY_GAP', 'getBlock');
    if (!isRecord(result)) throw new SolanaScannerFault('BLOCK_SCHEMA');
    const blockHeight = readUint(result.blockHeight, 'BLOCK_HEIGHT');
    const blockTime = readUint(result.blockTime, 'BLOCK_TIME');
    const parentSlot = readUint(result.parentSlot, 'PARENT_SLOT');
    if (blockHeight > MAX_BLOCK_HEIGHT || blockTime > MAX_BLOCK_HEIGHT)
      throw new SolanaScannerFault('BLOCK_RANGE');
    const blockhash = requireHash(result.blockhash, 'BLOCK_HASH');
    const previousBlockhash = requireHash(
      result.previousBlockhash,
      'PARENT_HASH',
    );
    if (
      parentSlot >= slot ||
      !Array.isArray(result.transactions) ||
      result.transactions.length > this.maxTransactionsPerBlock
    )
      throw new SolanaScannerFault('BLOCK_SCHEMA');
    const seen = new Set<string>();
    const transactions = result.transactions.map((value, transactionIndex) => {
      if (!isRecord(value) || !isRecord(value.transaction))
        throw new SolanaScannerFault('TRANSACTION_SCHEMA');
      const signatures = value.transaction.signatures;
      if (!Array.isArray(signatures) || signatures.length === 0)
        throw new SolanaScannerFault('TRANSACTION_SIGNATURE');
      const signature = signatures[0];
      if (!isCanonicalBase58(signature, 64))
        throw new SolanaScannerFault('TRANSACTION_SIGNATURE');
      if (seen.has(signature))
        throw new SolanaScannerFault('DUPLICATE_TRANSACTION');
      seen.add(signature);
      return { signature, transactionIndex };
    });
    return {
      slot,
      blockHeight,
      blockhash,
      parentSlot,
      previousBlockhash,
      blockTime,
      commitment: 'finalized',
      transactions,
      rawResponse: body,
    };
  };

  /** Compose the RPC-reported finalized slot and validated block fields into a head. */
  getFinalizedHead = async (): Promise<SolanaFinalizedHead> => {
    const finalizedSlot = await this.getFinalizedSlot();
    const block = await this.getBlock(finalizedSlot, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!block) throw new SolanaScannerFault('HISTORY_GAP', 'getBlock');
    return {
      slot: block.slot,
      blockHeight: block.blockHeight,
      blockhash: block.blockhash,
      commitment: 'finalized',
    };
  };
}
