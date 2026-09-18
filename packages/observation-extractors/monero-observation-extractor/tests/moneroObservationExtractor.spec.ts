import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';

import { MoneroCandidateEntity } from '../lib/entities/moneroCandidateEntity';
import { MoneroObservationExtractor } from '../lib/moneroObservationExtractor';
import { AdmissionVerifier, MoneroCandidateInput } from '../lib/types';
import {
  accepted,
  chainFixture,
  diskFixture,
  input,
  options,
  TestScanner,
} from './fixtures';

describe('durable Monero admission through the Rosen scanner', () => {
  let disk: Awaited<ReturnType<typeof diskFixture>>;
  beforeEach(async () => {
    disk = await diskFixture();
  });
  afterEach(async () => {
    await disk.close();
  });

  const extractor = (verify: AdmissionVerifier, now: () => number) =>
    new MoneroObservationExtractor<MoneroCandidateInput>(
      disk.scannerDb,
      disk.admissionDb,
      { ...options, now },
      (tx) => tx,
      verify,
      { verificationTimeoutMs: 100, maxConcurrentVerifications: 2 },
    );

  it('advances past a missing proof and admits it at the original height after chain growth', async () => {
    let time = 1000;
    const available = new Set([input(2).txId]);
    const ex = extractor(
      async (c) =>
        available.has(c.txId) ? accepted(c) : { status: 'pending' },
      () => time,
    );
    const chain = chainFixture([[], [input(1)], [input(2)]]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    expect((await scanner.action.getLastSavedBlock())?.height).toBe(2);
    expect(await ex.processPending(2)).toMatchObject({
      claimed: 2,
      accepted: 1,
      pending: 1,
      failed: 0,
    });
    chain.blocks.push({
      height: 3,
      hash: 'a'.repeat(64),
      parentHash: chain.blocks[2].hash,
      timestamp: 1003,
      txCount: 0,
    });
    chain.transactions.push([]);
    await scanner.update();
    available.add(input(1).txId);
    time += 20;
    expect(await ex.processPending(2)).toMatchObject({
      claimed: 1,
      accepted: 1,
    });
    const rows = await disk.scannerDb
      .getRepository(ObservationEntity)
      .find({ order: { height: 'ASC' } });
    expect(rows.map((r) => [r.sourceTxId, r.height, r.block])).toEqual([
      [input(1).txId, 1, chain.blocks[1].hash],
      [input(2).txId, 2, chain.blocks[2].hash],
    ]);
    expect((await scanner.action.getLastSavedBlock())?.height).toBe(3);
  });

  it('awaits the decoder and captures only recognized transactions in source order', async () => {
    const decoded: number[] = [];
    const ex = new MoneroObservationExtractor<MoneroCandidateInput>(
      disk.scannerDb,
      disk.admissionDb,
      options,
      async (tx) => {
        decoded.push(Number(tx.txId.slice(-2)));
        await new Promise((resolve) => setTimeout(resolve, 2));
        return tx.txId === input(2).txId ? tx : undefined;
      },
      async (candidate) => accepted(candidate),
    );
    const chain = chainFixture([[], [input(1), input(2), input(3)]]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    expect(decoded).toEqual([1, 2, 3]);
    expect(await ex.processPending(1)).toMatchObject({
      claimed: 1,
      accepted: 1,
    });
  });

  it('does not capture or advance when a later decoder call fails', async () => {
    const ex = new MoneroObservationExtractor<MoneroCandidateInput>(
      disk.scannerDb,
      disk.admissionDb,
      options,
      async (tx) => {
        if (tx.txId === input(2).txId) throw Error('decoder failed');
        return tx;
      },
      async (candidate) => accepted(candidate),
    );
    const chain = chainFixture([[], [input(1), input(2)]]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    expect(
      await disk.admissionDb.getRepository(MoneroCandidateEntity).count(),
    ).toBe(0);
    expect((await scanner.action.getLastSavedBlock())?.height).toBe(0);
  });

  it('keeps a malformed delivery retryable and recovers on a later valid response', async () => {
    let time = 1000;
    let valid = false;
    const ex = extractor(
      async (c) => {
        if (!valid) throw Error('malformed proof');
        return accepted(c);
      },
      () => time,
    );
    const chain = chainFixture([[], [input(1)]]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    expect(await ex.processPending(1)).toMatchObject({
      failed: 1,
      accepted: 0,
    });
    expect(await disk.scannerDb.getRepository(ObservationEntity).count()).toBe(
      0,
    );
    valid = true;
    time += 20;
    expect(await ex.processPending(1)).toMatchObject({ accepted: 1 });
  });

  it('rejects a shared SQLite connection that could interleave scanner transactions', () => {
    expect(
      () =>
        new MoneroObservationExtractor(
          disk.scannerDb,
          disk.scannerDb,
          options,
          (tx) => tx as MoneroCandidateInput,
          async () => ({ status: 'pending' }),
        ),
    ).toThrow(/separate/i);
  });

  it('recovers a capture/cursor crash in a fresh process without losing or duplicating observations', async () => {
    const run = promisify(execFile);
    await disk.admissionDb.destroy();
    await disk.scannerDb.destroy();
    await expect(
      run(process.execPath, [
        '--import=tsx',
        'tests/restartWorker.ts',
        disk.database,
        'capture-crash',
      ]),
    ).rejects.toMatchObject({ code: 17 });
    const { stdout } = await run(process.execPath, [
      '--import=tsx',
      'tests/restartWorker.ts',
      disk.database,
      'recover',
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      cursor: 2,
      observations: 2,
      result: { accepted: 2, failed: 0 },
    });
    const again = await run(process.execPath, [
      '--import=tsx',
      'tests/restartWorker.ts',
      disk.database,
      'recover',
    ]);
    expect(JSON.parse(again.stdout)).toMatchObject({
      cursor: 2,
      observations: 2,
      result: { claimed: 0 },
    });
  }, 20000);

  it('rejects verification finishing after the actual scanner rolls back its source block', async () => {
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ex = extractor(
      async (candidate) => {
        enter();
        await wait;
        return accepted(candidate);
      },
      () => 1000,
    );
    const chain = chainFixture([[], [input(1)], []]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    const run = ex.processPending(1);
    await started;
    chain.blocks[1] = { ...chain.blocks[1], hash: 'b'.repeat(64) };
    chain.blocks[2] = {
      ...chain.blocks[2],
      hash: 'c'.repeat(64),
      parentHash: chain.blocks[1].hash,
    };
    chain.transactions[1] = [];
    chain.blocks[1].txCount = 0;
    await scanner.update();
    finish();
    expect(await run).toMatchObject({ stale: 1, accepted: 0, failed: 0 });
    expect(await disk.scannerDb.getRepository(ObservationEntity).count()).toBe(
      0,
    );
  });

  it('bounds providers that ignore cancellation and discards their late result', async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const ex = new MoneroObservationExtractor<MoneroCandidateInput>(
      disk.scannerDb,
      disk.admissionDb,
      options,
      (tx) => tx,
      async (candidate) => {
        calls++;
        await wait;
        return accepted(candidate);
      },
      { verificationTimeoutMs: 10, maxConcurrentVerifications: 1 },
    );
    const chain = chainFixture([[], [input(1)], [input(2)]]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    expect(await ex.processPending(2)).toMatchObject({
      failed: 1,
      accepted: 0,
    });
    expect(await ex.processPending(2)).toMatchObject({ claimed: 0 });
    expect(calls).toBe(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await disk.scannerDb.getRepository(ObservationEntity).count()).toBe(
      0,
    );
  });
  it('closes pending verification without admitting its eventual result', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ex = extractor(
      async (candidate) => {
        enter();
        await finished;
        return accepted(candidate);
      },
      () => 1000,
    );
    const chain = chainFixture([[], [input(1)]]);
    const scanner = new TestScanner(
      'monero',
      disk.scannerDb,
      -1,
      chain.network,
    );
    await scanner.registerExtractor(ex);
    await scanner.update();
    const pending = ex.processPending(1);
    await entered;
    ex.close();
    expect(await pending).toMatchObject({ failed: 1, accepted: 0 });
    finish();
    await expect(ex.processPending(1)).rejects.toThrow(/closed/);
    expect(await disk.scannerDb.getRepository(ObservationEntity).count()).toBe(
      0,
    );
  });
});
