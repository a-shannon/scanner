import {
  AbstractNetworkConnector,
  Block,
} from '@rosen-bridge/scanner-interfaces';

import { MoneroCandidateInput } from './types';

export interface MoneroNetworkOptions {
  endpoints: string[];
  genesis: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxBlockTransactions?: number;
  maxBlockBytes?: number;
  batchSize?: number;
  fetch?: typeof fetch;
}

export interface MoneroBlockPacket {
  blockHex: string;
  blockHash: string;
  height: number;
  miner: MoneroIndexedTransaction;
  transactions: readonly MoneroIndexedTransaction[];
}

export interface MoneroIndexedTransaction {
  txId: string;
  transactionHex: string;
  outputIndices: readonly number[];
}

export interface MoneroOutput {
  index: number;
  key: string;
  mask: string;
  txId: string;
  height: number;
  unlocked: boolean;
}

type RecordValue = Record<string, unknown>;
type RpcMethod =
  | 'get_block'
  | 'get_info'
  | 'get_transactions'
  | 'get_outs'
  | 'is_key_image_spent';
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid RPC object');
  return value as RecordValue;
};
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw Error('Invalid RPC integer');
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw Error('Invalid RPC hash');
  return value;
};
const bytes = (value: unknown, max: number): string => {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > max * 2 ||
    !/^(?:[0-9a-f]{2})+$/.test(value)
  )
    throw Error('Invalid RPC bytes');
  return value;
};
const outputIndices = (value: unknown): number[] => {
  if (!Array.isArray(value)) throw Error('Invalid output indices');
  const result = value.map((item) => integer(item));
  if (new Set(result).size !== result.length)
    throw Error('Duplicate output indices');
  return result;
};
const agree = <T>(values: T[]): T => {
  if (
    values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))
  )
    throw Error('Monero endpoints disagree');
  return values[0];
};

/**
 * All configured daemons must agree. URL diversity is not proof of independent
 * administration. The native verifier must still validate block/transaction
 * hashes, vault ownership, proofs and output properties before admission.
 */
export class MoneroNetworkConnector extends AbstractNetworkConnector<MoneroCandidateInput> {
  private readonly endpoints: string[];
  private readonly genesis: string;
  private readonly timeout: number;
  private readonly responseLimit: number;
  private readonly transactionLimit: number;
  private readonly blockByteLimit: number;
  private readonly batchSize: number;
  private readonly fetcher: typeof fetch;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  close = () => {
    this.closed = true;
    for (const controller of this.controllers)
      controller.abort(Error('RPC connector closed'));
  };

  constructor(options: MoneroNetworkOptions) {
    super();
    this.endpoints = options.endpoints.map((endpoint) => {
      const url = new URL(endpoint);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      ) {
        throw Error(
          'RPC endpoints must be HTTP(S) origins without credentials',
        );
      }
      return url.origin;
    });
    if (
      this.endpoints.length < 2 ||
      this.endpoints.length > 8 ||
      new Set(this.endpoints).size !== this.endpoints.length
    )
      throw Error('Require 2 to 8 distinct endpoints');
    this.genesis = hash(options.genesis);
    this.timeout = integer(options.timeoutMs ?? 15000, 120000);
    this.responseLimit = integer(
      options.maxResponseBytes ?? 16 * 1024 * 1024,
      64 * 1024 * 1024,
    );
    this.transactionLimit = integer(
      options.maxBlockTransactions ?? 10000,
      100000,
    );
    this.blockByteLimit = integer(
      options.maxBlockBytes ?? 64 * 1024 * 1024,
      256 * 1024 * 1024,
    );
    this.batchSize = integer(options.batchSize ?? 16, 128);
    if (
      !this.timeout ||
      this.responseLimit < 1024 ||
      this.blockByteLimit < 1024 ||
      !this.transactionLimit ||
      !this.batchSize
    )
      throw Error('Invalid RPC bounds');
    this.fetcher = options.fetch ?? fetch;
  }

  private rpc = async (
    endpoint: string,
    method: RpcMethod,
    parameters: RecordValue,
  ): Promise<RecordValue> => {
    if (this.closed) throw Error('RPC connector closed');
    const controller = new AbortController();
    this.controllers.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async () => {
      const jsonRpc =
        method !== 'get_transactions' &&
        method !== 'get_outs' &&
        method !== 'is_key_image_spent';
      const path = jsonRpc ? '/json_rpc' : `/${method}`;
      const response = await this.fetcher(endpoint + path, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          jsonRpc
            ? { jsonrpc: '2.0', id: '0', method, params: parameters }
            : parameters,
        ),
      });
      if (controller.signal.aborted) {
        void response.body?.cancel();
        throw Error('RPC timeout');
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel();
        throw Error('RPC HTTP failure');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.responseLimit)
          throw Error('RPC response limit exceeded');
        chunks.push(value);
      }
      const envelope = record(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks, size),
          ),
        ),
      );
      if ('error' in envelope) throw Error('RPC error');
      if (jsonRpc && (envelope.jsonrpc !== '2.0' || envelope.id !== '0'))
        throw Error('Invalid RPC envelope');
      const result = jsonRpc ? record(envelope.result) : envelope;
      if (result.status !== 'OK' || result.untrusted !== false)
        throw Error('Untrusted or unavailable daemon');
      return result;
    };
    let onAbort: () => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader?.cancel().catch(() => {});
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => controller.abort(Error('RPC timeout')),
        this.timeout,
      );
    });
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
      this.controllers.delete(controller);
    }
  };

  private readBlock = async (endpoint: string, height: number) => {
    const response = await this.rpc(endpoint, 'get_block', { height });
    const header = record(response.block_header);
    if (integer(header.height) !== height || header.orphan_status !== false)
      throw Error('Invalid block anchor');
    const ids = response.tx_hashes ?? [];
    if (!Array.isArray(ids) || ids.length > this.transactionLimit)
      throw Error('Block transaction limit exceeded');
    const txIds = ids.map(hash);
    if (
      new Set(txIds).size !== txIds.length ||
      integer(header.num_txes) !== txIds.length
    )
      throw Error('Invalid block transaction set');
    return {
      height,
      hash: hash(header.hash),
      parentHash: hash(header.prev_hash),
      timestamp: integer(header.timestamp),
      txIds,
      blob: bytes(response.blob, this.responseLimit),
    };
  };

  private checkGenesis = async () => {
    const blocks = await Promise.all(
      this.endpoints.map((endpoint) => this.readBlock(endpoint, 0)),
    );
    if (agree(blocks).hash !== this.genesis)
      throw Error('Wrong Monero genesis');
  };

  getCurrentHeight = async (): Promise<number> => {
    await this.checkGenesis();
    const counts = await Promise.all(
      this.endpoints.map(async (endpoint) =>
        integer((await this.rpc(endpoint, 'get_info', {})).height),
      ),
    );
    const height = Math.min(...counts) - 1;
    if (height < 0) throw Error('Empty Monero chain');
    agree(
      await Promise.all(
        this.endpoints.map((endpoint) => this.readBlock(endpoint, height)),
      ),
    );
    return height;
  };

  getBlockAtHeight = async (height: number): Promise<Block> => {
    integer(height);
    await this.checkGenesis();
    const block = agree(
      await Promise.all(
        this.endpoints.map((endpoint) => this.readBlock(endpoint, height)),
      ),
    );
    return {
      height,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      txCount: block.txIds.length,
      extra: block.blob,
    };
  };

  getBlockTxs = async (
    blockHash: string,
    height: number,
  ): Promise<MoneroCandidateInput[]> => {
    hash(blockHash);
    integer(height);
    await this.checkGenesis();
    const block = agree(
      await Promise.all(
        this.endpoints.map((endpoint) => this.readBlock(endpoint, height)),
      ),
    );
    if (block.hash !== blockHash) throw Error('Source block changed');
    const transactions: MoneroCandidateInput[] = [];
    let blockBytes = block.blob.length / 2;
    if (blockBytes > this.blockByteLimit)
      throw Error('Block byte limit exceeded');
    for (
      let offset = 0;
      offset < block.txIds.length;
      offset += this.batchSize
    ) {
      const wanted = block.txIds.slice(offset, offset + this.batchSize);
      const batch = await Promise.all(
        this.endpoints.map(async (endpoint) => {
          const response = await this.rpc(endpoint, 'get_transactions', {
            txs_hashes: wanted,
            decode_as_json: false,
            prune: false,
            split: false,
          });
          if (
            response.missed_tx !== undefined &&
            (!Array.isArray(response.missed_tx) ||
              response.missed_tx.length !== 0)
          )
            throw Error('Missing transaction');
          if (
            !Array.isArray(response.txs) ||
            response.txs.length !== wanted.length
          )
            throw Error('Incomplete transaction batch');
          const rows = new Map<string, MoneroCandidateInput>();
          for (const value of response.txs) {
            const row = record(value);
            const txId = hash(row.tx_hash);
            if (
              !wanted.includes(txId) ||
              rows.has(txId) ||
              row.in_pool !== false ||
              integer(row.block_height) !== height
            )
              throw Error('Invalid transaction anchor');
            rows.set(txId, {
              txId,
              transactionHex: bytes(row.as_hex, this.responseLimit),
            });
          }
          return wanted.map((id) => rows.get(id)!);
        }),
      );
      const agreed = agree(batch);
      blockBytes += agreed.reduce(
        (sum, tx) => sum + tx.transactionHex.length / 2,
        0,
      );
      if (blockBytes > this.blockByteLimit)
        throw Error('Block byte limit exceeded');
      transactions.push(...agreed);
    }
    // Compare the immutable source block, not a tip that may legitimately grow.
    agree([
      block,
      ...(await Promise.all(
        this.endpoints.map((endpoint) => this.readBlock(endpoint, height)),
      )),
    ]);
    return transactions;
  };

  private readTransactionRows = async (
    height: number,
    ids: string[],
    initialBytes = 0,
    minerId?: string,
  ): Promise<MoneroIndexedTransaction[]> => {
    const rows: MoneroIndexedTransaction[] = [];
    let totalBytes = initialBytes;
    if (totalBytes > this.blockByteLimit)
      throw Error('Block byte limit exceeded');
    for (let offset = 0; offset < ids.length; offset += this.batchSize) {
      const wanted = ids.slice(offset, offset + this.batchSize);
      const peers = await Promise.all(
        this.endpoints.map(async (endpoint) => {
          const response = await this.rpc(endpoint, 'get_transactions', {
            txs_hashes: wanted,
            decode_as_json: false,
            prune: false,
            split: false,
          });
          if (
            response.missed_tx !== undefined &&
            (!Array.isArray(response.missed_tx) ||
              response.missed_tx.length !== 0)
          )
            throw Error('Missing transaction');
          if (
            !Array.isArray(response.txs) ||
            response.txs.length !== wanted.length
          )
            throw Error('Incomplete transaction batch');
          const byId = new Map<string, MoneroIndexedTransaction>();
          for (const value of response.txs) {
            const row = record(value);
            const txId = hash(row.tx_hash);
            if (
              !wanted.includes(txId) ||
              byId.has(txId) ||
              row.in_pool !== false ||
              integer(row.block_height) !== height
            )
              throw Error('Invalid transaction anchor');
            let transactionHex: string;
            if (row.as_hex !== '') {
              transactionHex = bytes(row.as_hex, this.responseLimit);
            } else {
              if (
                txId !== minerId ||
                row.prunable_as_hex !== '' ||
                typeof row.prunable_hash !== 'string'
              )
                throw Error('Invalid split transaction');
              hash(row.prunable_hash);
              transactionHex = bytes(row.pruned_as_hex, this.responseLimit);
            }
            byId.set(txId, {
              txId,
              transactionHex,
              outputIndices: outputIndices(row.output_indices),
            });
          }
          return wanted.map((id) => byId.get(id)!);
        }),
      );
      const agreed = agree(peers);
      const batchBytes = agreed.reduce(
        (sum, tx) => sum + tx.transactionHex.length / 2,
        0,
      );
      totalBytes += batchBytes;
      if (totalBytes > this.blockByteLimit)
        throw Error('Block byte limit exceeded');
      rows.push(...agreed);
    }
    return rows;
  };

  getBlockPacket = async (
    blockHash: string,
    height: number,
  ): Promise<MoneroBlockPacket> => {
    hash(blockHash);
    integer(height);
    await this.checkGenesis();
    const block = agree(
      await Promise.all(
        this.endpoints.map((endpoint) => this.readBlock(endpoint, height)),
      ),
    );
    if (block.hash !== blockHash) throw Error('Source block changed');
    const minerIds = await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const response = await this.rpc(endpoint, 'get_block', { height });
        return hash(record(response).miner_tx_hash);
      }),
    );
    const minerId = agree(minerIds);
    const rows = await this.readTransactionRows(
      height,
      [minerId, ...block.txIds],
      block.blob.length / 2,
      minerId,
    );
    if (rows.length !== block.txIds.length + 1 || rows[0].txId !== minerId)
      throw Error('Invalid block transaction packet');
    const packet = {
      blockHex: block.blob,
      blockHash: block.hash,
      height,
      miner: rows[0],
      transactions: rows.slice(1),
    };
    agree([
      block,
      ...(await Promise.all(
        this.endpoints.map((endpoint) => this.readBlock(endpoint, height)),
      )),
    ]);
    const minerIdsAfter = await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const response = await this.rpc(endpoint, 'get_block', { height });
        return hash(record(response).miner_tx_hash);
      }),
    );
    if (agree(minerIdsAfter) !== minerId)
      throw Error('Source miner transaction changed');
    const freezeTx = (tx: MoneroIndexedTransaction) =>
      Object.freeze({
        ...tx,
        outputIndices: Object.freeze([...tx.outputIndices]),
      });
    return Object.freeze({
      ...packet,
      miner: freezeTx(packet.miner),
      transactions: Object.freeze(packet.transactions.map(freezeTx)),
    });
  };

  getOutput = async (globalIndex: number): Promise<MoneroOutput> => {
    integer(globalIndex);
    await this.checkGenesis();
    const peers = await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const response = await this.rpc(endpoint, 'get_outs', {
          outputs: [{ amount: 0, index: globalIndex }],
          get_txid: true,
        });
        if (!Array.isArray(response.outs) || response.outs.length !== 1)
          throw Error('Invalid output response');
        const row = record(response.outs[0]);
        if (typeof row.unlocked !== 'boolean')
          throw Error('Invalid output unlocked flag');
        return {
          index: globalIndex,
          key: hash(row.key),
          mask: hash(row.mask),
          txId: hash(row.txid),
          height: integer(row.height),
          unlocked: row.unlocked,
        };
      }),
    );
    return Object.freeze(agree(peers));
  };

  getKeyImageStatus = async (image: string): Promise<0 | 1 | 2> => {
    hash(image);
    await this.checkGenesis();
    const peers = await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const response = await this.rpc(endpoint, 'is_key_image_spent', {
          key_images: [image],
        });
        if (
          !Array.isArray(response.spent_status) ||
          response.spent_status.length !== 1
        )
          throw Error('Invalid key image response');
        const status = integer(response.spent_status[0], 2);
        return status as 0 | 1 | 2;
      }),
    );
    return agree(peers);
  };
}
