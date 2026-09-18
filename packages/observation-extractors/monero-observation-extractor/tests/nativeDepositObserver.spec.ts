import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { MoneroBlockPacket } from '../lib/moneroNetworkConnector';
import {
  NativeDepositCommittee,
  NativeDepositObserver,
  NativeDepositObserverOptions,
} from '../lib/nativeDepositObserver';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const hex = (value: number) => value.toString(16).padStart(64, '0');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const digest = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(domain)
    .update(Buffer.from([0]))
    .update(canonical(value))
    .digest('hex');

const committee = (): NativeDepositCommittee => ({
  genesis: hex(1),
  epoch: hex(2),
  ceremony: hex(3),
  threshold: 2,
  profile: 'ed25519-shamir-untweaked-standard',
  roster: {
    groupKey: hex(4),
    verificationShares: [1, 2, 3, 4].map((id) => ({
      id,
      publicKey: hex(10 + id),
    })),
  },
  identities: [1, 2, 3, 4].map((id) => ({
    id,
    publicKey: `02${hex(20 + id)}`,
  })),
  sourcePolicy: 'authenticated-backing-v1',
});
const packet = (): MoneroBlockPacket => ({
  blockHex: 'aa',
  blockHash: hex(30),
  height: 4097,
  miner: {
    txId: hex(31),
    transactionHex: 'bb',
    outputIndices: [100],
  },
  transactions: [
    {
      txId: hex(32),
      transactionHex: 'cc',
      outputIndices: [101, 102],
    },
  ],
});
const certificate = () =>
  `${canonical({ config: { source: { kind: 'deposit' }, type: 'inspect-source' } })}\n`;

type Handler = (input: string, child: FakeChild) => void | Promise<void>;
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private closed = false;
  private readonly chunks: Buffer[] = [];

  constructor(handler: Handler) {
    super();
    this.stdin.on('data', (chunk: Buffer) =>
      this.chunks.push(Buffer.from(chunk)),
    );
    this.stdin.on('end', () => {
      queueMicrotask(() => {
        void Promise.resolve(
          handler(Buffer.concat(this.chunks).toString('utf8'), this),
        ).catch(() => this.finish(1));
      });
    });
  }

  readonly kill = vi.fn(() => {
    setTimeout(() => this.finish(null, 'SIGKILL'), 5);
    return true;
  });

  finish(code: number | null, signal: string | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }
}

describe('NativeDepositObserver', () => {
  let directory: string;
  let binary: string;
  let binaryHash: string;

  beforeEach(async () => {
    spawnMock.mockReset();
    directory = await mkdtemp(join(tmpdir(), 'rosen-native-observer-'));
    binary = join(directory, 'trusted-native.exe');
    await writeFile(binary, 'trusted fixture bytes');
    binaryHash = createHash('sha256')
      .update('trusted fixture bytes')
      .digest('hex');
  });

  afterEach(async () => {
    await unlink(binary).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  });

  const options = (
    configuredCommittee: NativeDepositCommittee = committee(),
  ): NativeDepositObserverOptions => ({
    nativeBinary: binary,
    nativeBinarySha256: binaryHash,
    committee: configuredCommittee,
    viewKey: hex(40),
    timeoutMs: 1_000,
    maxInputBytes: 1024 * 1024,
    maxOutputBytes: 64 * 1024,
  });

  const nativeResult = (input: Record<string, unknown>) => {
    const config = {
      ...((JSON.parse(input.certificate as string) as Record<string, unknown>)
        .config as Record<string, unknown>),
    };
    delete config.type;
    const requestPacket = input.packet as MoneroBlockPacket;
    const configuredCommittee = input.committee as NativeDepositCommittee;
    return {
      version: 1,
      committeeDigest: digest(
        'rosen-monero/source-certificate-committee/v1',
        configuredCommittee,
      ),
      sourceBinding: digest('rosen-monero/local-source-config/v1', config),
      genesis: configuredCommittee.genesis,
      vaultAddress: `4${'1'.repeat(94)}`,
      txId: input.txId,
      blockHash: requestPacket.blockHash,
      blockHeight: requestPacket.height,
      outputIndex: input.outputIndex,
      globalIndex:
        requestPacket.transactions[0].outputIndices[
          input.outputIndex as number
        ],
      outputKey: hex(50),
      commitment: hex(51),
      amountAtomic: '10000000000',
      keyImage: hex(52),
      depositData: ['deadbeef'],
    };
  };

  const respondSuccessfully = (
    transform?: (value: Record<string, unknown>) => void,
  ) => {
    let captured = '';
    spawnMock.mockImplementation(() => {
      const child = new FakeChild((input, process) => {
        captured = input;
        const request = JSON.parse(input) as Record<string, unknown>;
        const result = nativeResult(request);
        transform?.(result);
        process.stdout.write(`${canonical(result)}\n`);
        process.finish(0);
      });
      return child;
    });
    return () => captured;
  };

  it('sends one canonical authority-bound frame and accepts only the bound result', async () => {
    const configured = committee();
    const observer = new NativeDepositObserver(options(configured));
    configured.genesis = hex(999);
    configured.roster.verificationShares[0].publicKey = hex(998);
    const captured = respondSuccessfully();

    const result = await observer.observe(
      packet(),
      certificate(),
      hex(32),
      1,
      new AbortController().signal,
    );

    expect(spawnMock).toHaveBeenCalledWith(binary, ['verify-deposit'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const wire = captured();
    expect(wire.endsWith('\n')).toBe(true);
    expect(wire.slice(0, -1)).toBe(canonical(JSON.parse(wire)));
    const sent = JSON.parse(wire) as Record<string, unknown> & {
      committee: {
        roster: {
          verificationShares: Array<{ id: number; publicKey: string }>;
        };
      };
    };
    expect(sent).toMatchObject({
      version: 1,
      committee: { genesis: hex(1) },
      viewKey: hex(40),
      txId: hex(32),
      outputIndex: 1,
    });
    expect(sent.committee.roster.verificationShares[0]).toEqual({
      id: 1,
      publicKey: hex(11),
    });
    expect(result).toMatchObject({
      txId: hex(32),
      blockHash: hex(30),
      blockHeight: 4097,
      outputIndex: 1,
      globalIndex: 102,
      amountAtomic: '10000000000',
    });
    expect('viewKey' in result).toBe(false);
    expect('offset' in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.depositData)).toBe(true);
    expect(Object.isFrozen(observer.committee)).toBe(true);
  });

  it.each([
    [
      'committee digest',
      (value: Record<string, unknown>) => (value.committeeDigest = hex(90)),
    ],
    ['genesis', (value: Record<string, unknown>) => (value.genesis = hex(91))],
    ['block', (value: Record<string, unknown>) => (value.blockHash = hex(92))],
    ['height', (value: Record<string, unknown>) => (value.blockHeight = 4098)],
    ['transaction', (value: Record<string, unknown>) => (value.txId = hex(93))],
    ['output', (value: Record<string, unknown>) => (value.outputIndex = 0)],
    [
      'global index',
      (value: Record<string, unknown>) => (value.globalIndex = 101),
    ],
  ])(
    'rejects a native result with mismatched %s binding',
    async (_name, mutate) => {
      respondSuccessfully(mutate);
      const observer = new NativeDepositObserver(options());
      await expect(
        observer.observe(
          packet(),
          certificate(),
          hex(32),
          1,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Invalid native deposit result');
    },
  );

  it('rejects noncanonical, extra-field, alias, and unsafe-number stdout', async () => {
    const modes = [
      (result: Record<string, unknown>) =>
        `${JSON.stringify(result, null, 2)}\n`,
      (result: Record<string, unknown>) =>
        `${canonical({ ...result, extra: true })}\n`,
      (result: Record<string, unknown>) =>
        `${canonical({ ...result, amountAtomic: 1 })}\n`,
      (result: Record<string, unknown>) =>
        `${canonical({ ...result, globalIndex: 9_007_199_254_740_992 })}\n`,
      (result: Record<string, unknown>) => canonical(result),
    ];
    for (const encode of modes) {
      spawnMock.mockImplementation(
        () =>
          new FakeChild((input, process) => {
            process.stdout.write(encode(nativeResult(JSON.parse(input))));
            process.finish(0);
          }),
      );
      const observer = new NativeDepositObserver(options());
      await expect(
        observer.observe(
          packet(),
          certificate(),
          hex(32),
          1,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Invalid native deposit result');
    }
  });

  it('rejects malformed candidate packets before spawning', async () => {
    const observer = new NativeDepositObserver(options());
    const invalid = packet() as MoneroBlockPacket & { authority?: unknown };
    invalid.authority = committee();
    await expect(
      observer.observe(
        invalid,
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid native deposit request');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('kills on abort and waits for close without exposing the abort reason', async () => {
    let child: FakeChild | undefined;
    spawnMock.mockImplementation(() => {
      child = new FakeChild(() => undefined);
      return child;
    });
    const observer = new NativeDepositObserver(options());
    const controller = new AbortController();
    const pending = observer.observe(
      packet(),
      certificate(),
      hex(32),
      1,
      controller.signal,
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    controller.abort(Error(`secret-${hex(40)}`));
    await expect(pending).rejects.toThrow('Native deposit observation aborted');
    expect(child?.kill).toHaveBeenCalledOnce();
  });

  it('kills on deadline and waits for close', async () => {
    let child: FakeChild | undefined;
    spawnMock.mockImplementation(() => {
      child = new FakeChild(() => undefined);
      return child;
    });
    const observer = new NativeDepositObserver({ ...options(), timeoutMs: 1 });
    await expect(
      observer.observe(
        packet(),
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Native deposit observation timed out');
    expect(child?.kill).toHaveBeenCalledOnce();
  });

  it('bounds combined stdout and stderr and never returns child diagnostics', async () => {
    spawnMock.mockImplementation(
      () =>
        new FakeChild((_input, process) => {
          process.stderr.write(`secret-${hex(40)}`);
          process.stdout.write(Buffer.alloc(70 * 1024, 1));
        }),
    );
    const observer = new NativeDepositObserver(options());
    const error = (await observer
      .observe(
        packet(),
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      )
      .catch((reason: Error) => reason)) as Error;
    expect(error.message).toBe('Native deposit output limit exceeded');
    expect(error.message).not.toContain(hex(40));
  });

  it('checks the executable hash before and after the child closes', async () => {
    const observer = new NativeDepositObserver(options());
    respondSuccessfully();
    await writeFile(binary, 'wrong before spawn');
    await expect(
      observer.observe(
        packet(),
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Native deposit binary integrity failure');
    expect(spawnMock).not.toHaveBeenCalled();

    await writeFile(binary, 'trusted fixture bytes');
    spawnMock.mockImplementation(
      () =>
        new FakeChild(async (input, process) => {
          process.stdout.write(
            `${canonical(nativeResult(JSON.parse(input)))}\n`,
          );
          await writeFile(binary, 'changed after spawn');
          process.finish(0);
        }),
    );
    await expect(
      observer.observe(
        packet(),
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Native deposit binary integrity failure');
  });

  it('enforces the input bound before spawning and hides child diagnostics', async () => {
    const bounded = new NativeDepositObserver({
      ...options(),
      maxInputBytes: 256,
    });
    await expect(
      bounded.observe(
        packet(),
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid native deposit request');
    expect(spawnMock).not.toHaveBeenCalled();

    spawnMock.mockImplementation(
      () =>
        new FakeChild((_input, process) => {
          process.stderr.write(`private-${hex(40)}`);
          process.finish(1);
        }),
    );
    const observer = new NativeDepositObserver(options());
    const error = (await observer
      .observe(
        packet(),
        certificate(),
        hex(32),
        1,
        new AbortController().signal,
      )
      .catch((reason: Error) => reason)) as Error;
    expect(error.message).toBe('Native deposit verifier failed');
    expect(error.message).not.toContain(hex(40));
  });
});
