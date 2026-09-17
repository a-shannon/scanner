import {
  MoneroNetworkConnector,
  MoneroNetworkOptions,
} from '../lib/moneroNetworkConnector';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const setup = () => {
  let mutation: (
    host: string,
    method: string,
    result: Record<string, unknown>,
  ) => void = () => {};
  let tip = 4100;
  let blockReads = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    const request = JSON.parse(String(init?.body));
    const method = request.method ?? 'get_transactions';
    let result: Record<string, unknown> = { status: 'OK', untrusted: false };
    if (method === 'get_info') result.height = tip;
    else if (method === 'get_block') {
      const height = request.params.height;
      blockReads++;
      result = {
        ...result,
        blob: 'aabb',
        tx_hashes:
          height === 0
            ? []
            : Array.from({ length: 17 }, (_, i) => hash(i + 100)),
        block_header: {
          height,
          hash: hash(height + 1),
          prev_hash: hash(height),
          timestamp: 1000 + height,
          orphan_status: false,
          num_txes: height === 0 ? 0 : 17,
        },
      };
    } else if (method === 'get_transactions') {
      result.txs = request.txs_hashes.map((txId: string) => ({
        tx_hash: txId,
        as_hex: 'cc' + txId,
        block_height: 4097,
        in_pool: false,
      }));
    } else throw Error('Unexpected RPC');
    mutation(host, method, result);
    return new Response(
      JSON.stringify(
        request.method ? { jsonrpc: '2.0', id: '0', result } : result,
      ),
    );
  };
  const connector = (overrides: Partial<MoneroNetworkOptions> = {}) =>
    new MoneroNetworkConnector({
      endpoints: ['http://node-a.example', 'http://node-b.example'],
      genesis: hash(1),
      fetch: fetcher,
      ...overrides,
    });
  return {
    connector,
    mutate: (fn: typeof mutation) => {
      mutation = fn;
    },
    grow: () => {
      tip++;
    },
    reads: () => blockReads,
  };
};

describe('Monero daemon agreement connector', () => {
  it('reads height 4097 and 17 transactions without fixture-only limits', async () => {
    const f = setup();
    const network = f.connector();
    expect(await network.getCurrentHeight()).toBe(4099);
    expect(await network.getBlockAtHeight(4097)).toMatchObject({
      height: 4097,
      txCount: 17,
    });
    expect(await network.getBlockTxs(hash(4098), 4097)).toHaveLength(17);
  });
  it('allows chain growth while reading a stable source block', async () => {
    const f = setup();
    f.mutate((_host, method) => {
      if (method === 'get_transactions') f.grow();
    });
    expect(await f.connector().getBlockTxs(hash(4098), 4097)).toHaveLength(17);
  });
  it.each([
    'hash',
    'prev_hash',
    'height',
    'timestamp',
    'num_txes',
    'orphan_status',
  ])('rejects a peer mismatch in %s', async (field) => {
    const f = setup();
    f.mutate((host, method, result) => {
      if (host === 'node-b.example' && method === 'get_block') {
        const header = result.block_header as Record<string, unknown>;
        header[field] =
          typeof header[field] === 'number'
            ? Number(header[field]) + 1
            : field === 'orphan_status'
              ? true
              : hash(9999);
      }
    });
    await expect(f.connector().getBlockAtHeight(4097)).rejects.toThrow();
  });
  it.each(['tx_hash', 'as_hex', 'block_height', 'in_pool'])(
    'rejects a transaction mismatch in %s',
    async (field) => {
      const f = setup();
      f.mutate((host, method, result) => {
        if (host === 'node-b.example' && method === 'get_transactions') {
          const row = (result.txs as Record<string, unknown>[])[0];
          row[field] =
            field === 'block_height'
              ? 9
              : field === 'in_pool'
                ? true
                : field === 'as_hex'
                  ? 'abcd'
                  : hash(9999);
        }
      });
      await expect(
        f.connector().getBlockTxs(hash(4098), 4097),
      ).rejects.toThrow();
    },
  );
  it('rejects a replaced source after transaction retrieval', async () => {
    const f = setup();
    let fetched = false;
    f.mutate((_host, method, result) => {
      if (method === 'get_transactions') fetched = true;
      if (method === 'get_block' && fetched)
        (result.block_header as Record<string, unknown>).hash = hash(9999);
    });
    await expect(f.connector().getBlockTxs(hash(4098), 4097)).rejects.toThrow();
  });
  it.each(['missing', 'duplicate', 'untrusted', 'error'])(
    'rejects %s transaction data',
    async (mode) => {
      const f = setup();
      f.mutate((_host, method, result) => {
        if (method !== 'get_transactions') return;
        const rows = result.txs as Record<string, unknown>[];
        if (mode === 'missing') rows.pop();
        if (mode === 'duplicate') rows[1] = rows[0];
        if (mode === 'untrusted') result.untrusted = true;
        if (mode === 'error') result.status = 'BUSY';
      });
      await expect(
        f.connector().getBlockTxs(hash(4098), 4097),
      ).rejects.toThrow();
    },
  );
  it('rejects endpoint aliases instead of counting them as two peers', () => {
    expect(
      () =>
        new MoneroNetworkConnector({
          endpoints: ['http://same.example', 'http://same.example/'],
          genesis: hash(1),
        }),
    ).toThrow();
  });
  it('bounds response bytes and rejects truncated JSON', async () => {
    for (const body of ['x'.repeat(1025), '{"result":']) {
      const network = new MoneroNetworkConnector({
        endpoints: ['http://a.example', 'http://b.example'],
        genesis: hash(1),
        maxResponseBytes: 1024,
        fetch: async () => new Response(body),
      });
      await expect(network.getCurrentHeight()).rejects.toThrow();
    }
  });
  it('bounds the entire body read even if a response stream stalls', async () => {
    const network = new MoneroNetworkConnector({
      endpoints: ['http://a.example', 'http://b.example'],
      genesis: hash(1),
      timeoutMs: 10,
      fetch: async () => new Response(new ReadableStream({ start() {} })),
    });
    await expect(network.getCurrentHeight()).rejects.toThrow(/timeout/i);
  });
  it('bounds the complete block across individually bounded transaction batches', async () => {
    const f = setup();
    f.mutate((_host, method, result) => {
      if (method === 'get_transactions')
        for (const row of result.txs as Record<string, unknown>[])
          row.as_hex = 'aa'.repeat(100);
    });
    await expect(
      f
        .connector({ maxBlockBytes: 1024, batchSize: 1 })
        .getBlockTxs(hash(4098), 4097),
    ).rejects.toThrow(/Block byte limit/);
  });
  it('closes stalled body reads immediately and refuses further requests', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const network = new MoneroNetworkConnector({
      endpoints: ['http://a.example', 'http://b.example'],
      genesis: hash(1),
      fetch: async () => {
        enter();
        return new Response(new ReadableStream({ start() {} }));
      },
    });
    const pending = network.getCurrentHeight();
    await entered;
    network.close();
    await expect(pending).rejects.toThrow(/closed/i);
    await expect(network.getCurrentHeight()).rejects.toThrow(/closed/i);
  });
});
