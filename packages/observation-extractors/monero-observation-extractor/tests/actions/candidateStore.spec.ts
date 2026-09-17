import { afterEach, describe, expect, it } from 'vitest';

import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { CandidateStore } from '../../lib/actions/candidateStore';
import { MoneroCandidateEntity } from '../../lib/entities/moneroCandidateEntity';
import {
  accepted,
  diskFixture,
  hex,
  input,
  openDatabase,
  options,
} from '../fixtures';

describe('CandidateStore capture and claim', () => {
  const fixtures: Awaited<ReturnType<typeof diskFixture>>[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  const insertBlock = async (
    fixture: Awaited<ReturnType<typeof diskFixture>>,
    height: number,
    status = PROCEED,
  ) => {
    const block = {
      hash: hex(1000 + height),
      parentHash: hex(999 + height),
      height,
      status,
      scanner: options.scannerId,
      timestamp: height,
    };
    await fixture.scannerDb.getRepository(BlockEntity).insert(block);
    return block;
  };

  it('replays exact captures and rolls the whole batch back on conflicting bytes', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    let now = 1000;
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => now,
    });
    const block = { hash: hex(20), height: 20 };

    await store.capture([input(1)], block);
    await store.capture([input(1)], block);
    expect(
      await fixture.admissionDb.getRepository(MoneroCandidateEntity).count(),
    ).toBe(1);

    now += 1;
    await expect(
      store.capture(
        [input(2), { txId: input(1).txId, transactionHex: 'bbbb' }],
        block,
      ),
    ).rejects.toThrow(/conflict/i);
    expect(
      await fixture.admissionDb.getRepository(MoneroCandidateEntity).count(),
    ).toBe(1);
  });

  it('claims only due candidates anchored to the exact current PROCEED block', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    const now = 2000;
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => now,
    });
    const block = {
      hash: hex(30),
      parentHash: hex(29),
      height: 30,
      status: 'PROCESSING',
      scanner: options.scannerId,
      timestamp: 1,
    };
    await fixture.scannerDb.getRepository('block_entity').insert(block);
    await store.capture([input(3)], block);

    await expect(store.claim(1)).resolves.toEqual([]);
    await fixture.scannerDb
      .getRepository('block_entity')
      .update(
        { hash: block.hash, scanner: options.scannerId },
        { status: PROCEED },
      );

    const leases = await store.claim(1);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      txId: input(3).txId,
      sourceBlockId: block.hash,
      sourceHeight: block.height,
      revision: 1,
      expiresAt: now + options.leaseMs,
    });
    expect(leases[0].token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('schedules pending retries, recovers expired leases, and retains policy-expired evidence', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    let now = 3000;
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => now,
    });
    const block = await insertBlock(fixture, 40);
    await store.capture([input(4)], block);

    const [first] = await store.claim(1);
    await expect(store.complete(first, { status: 'pending' })).resolves.toBe(
      'pending',
    );
    now += options.retryMs - 1;
    await expect(store.claim(1)).resolves.toEqual([]);
    now += 1;
    const [second] = await store.claim(1);
    expect(second.revision).toBe(first.revision + 1);

    now = second.expiresAt;
    await expect(store.complete(second, { status: 'pending' })).resolves.toBe(
      'stale',
    );
    const [third] = await store.claim(1);
    expect(third.revision).toBe(second.revision + 1);
    await expect(store.complete(third, { status: 'expired' })).resolves.toBe(
      'expired',
    );
    now += options.leaseMs + options.retryMs;
    await expect(store.claim(1)).resolves.toEqual([]);

    const retained = await fixture.admissionDb
      .getRepository(MoneroCandidateEntity)
      .findOneByOrFail({ id: third.id });
    expect(retained).toMatchObject({
      state: 'expired',
      transactionHex: input(4).transactionHex,
    });
  });

  it('inserts a bound observation and makes completion replay stale', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => 4000,
    });
    const block = await insertBlock(fixture, 50);
    await store.capture([input(5)], block);
    const [lease] = await store.claim(1);

    await expect(store.complete(lease, accepted(lease))).resolves.toBe(
      'accepted',
    );
    await expect(store.complete(lease, accepted(lease))).resolves.toBe('stale');
    const observations = await fixture.admissionDb
      .getRepository(ObservationEntity)
      .find();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sourceTxId: lease.txId,
      sourceBlockId: lease.sourceBlockId,
      block: lease.sourceBlockId,
      height: lease.sourceHeight,
      extractor: options.extractorId,
    });
    await expect(store.createUsedBlocksQuery().getRawMany()).resolves.toEqual([
      { block: lease.sourceBlockId },
    ]);
  });

  it('rolls back malformed accepted results without consuming the lease', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => 5000,
    });
    const block = await insertBlock(fixture, 60);
    await store.capture([input(6)], block);
    const [lease] = await store.claim(1);
    const malformed = accepted(lease);
    if (malformed.status !== 'accepted')
      throw new Error('fixture is not accepted');
    malformed.observation.requestId = hex(9999);

    await expect(store.complete(lease, malformed)).rejects.toThrow(/requestId/);
    expect(
      await fixture.admissionDb.getRepository(ObservationEntity).count(),
    ).toBe(0);
    const candidate = await fixture.admissionDb
      .getRepository(MoneroCandidateEntity)
      .findOneByOrFail({ id: lease.id });
    expect(candidate).toMatchObject({
      state: 'pending',
      leaseToken: lease.token,
      revision: lease.revision,
    });
    await expect(store.complete(lease, accepted(lease))).resolves.toBe(
      'accepted',
    );
  });

  it('aborts both insertion and acceptance when an existing observation conflicts', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => 6000,
    });
    const block = await insertBlock(fixture, 70);
    await store.capture([input(7)], block);
    const [lease] = await store.claim(1);
    const result = accepted(lease);
    if (result.status !== 'accepted')
      throw new Error('fixture is not accepted');
    await fixture.scannerDb.getRepository(ObservationEntity).insert({
      ...result.observation,
      amount: '999',
      height: lease.sourceHeight,
      block: lease.sourceBlockId,
      extractor: options.extractorId,
    });

    await expect(store.complete(lease, result)).rejects.toThrow(/conflicts/);
    const candidate = await fixture.admissionDb
      .getRepository(MoneroCandidateEntity)
      .findOneByOrFail({ id: lease.id });
    expect(candidate).toMatchObject({
      state: 'pending',
      leaseToken: lease.token,
    });
    const observation = await fixture.admissionDb
      .getRepository(ObservationEntity)
      .findOneByOrFail({ requestId: result.observation.requestId });
    expect(observation.amount).toBe('999');
  });

  it('invalidates exact fork evidence, preserves unrelated observations, and reactivates exact recapture', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    let now = 7000;
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => now,
    });
    const block = await insertBlock(fixture, 80);
    await store.capture([input(8)], block);
    const [lease] = await store.claim(1);
    const result = accepted(lease);
    await store.complete(lease, result);
    await fixture.scannerDb.getRepository(ObservationEntity).insert({
      fromChain: 'monero',
      toChain: 'ergo',
      fromAddress: 'other-origin',
      toAddress: 'other-destination',
      amount: '1',
      networkFee: '0',
      bridgeFee: '0',
      sourceChainTokenId: 'xmr',
      targetChainTokenId: 'wrapped-xmr',
      sourceTxId: hex(8001),
      sourceBlockId: block.hash,
      requestId: hex(8002),
      rawData: '',
      height: block.height,
      block: block.hash,
      extractor: options.extractorId,
    });

    await store.forkBlock(block.hash);
    await expect(store.createUsedBlocksQuery().getRawMany()).resolves.toEqual(
      [],
    );
    const observations = await fixture.admissionDb
      .getRepository(ObservationEntity)
      .find();
    expect(observations).toHaveLength(1);
    expect(observations[0].requestId).toBe(hex(8002));
    const orphaned = await fixture.admissionDb
      .getRepository(MoneroCandidateEntity)
      .findOneByOrFail({ id: lease.id });
    expect(orphaned.state).toBe('orphaned');

    now += 1;
    await store.capture([input(8)], block);
    const reactivated = await fixture.admissionDb
      .getRepository(MoneroCandidateEntity)
      .findOneByOrFail({ id: lease.id });
    expect(reactivated).toMatchObject({
      state: 'pending',
      revision: orphaned.revision + 1,
      leaseToken: null,
    });
    const [nextLease] = await store.claim(1);
    expect(nextLease.revision).toBe(reactivated.revision + 1);
  });

  it('returns stale when the source stops being the exact PROCEED block', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    let now = 8000;
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => now,
    });
    const block = await insertBlock(fixture, 90);
    await store.capture([input(9)], block);
    const [lease] = await store.claim(1);
    await fixture.scannerDb
      .getRepository(BlockEntity)
      .update(
        { hash: block.hash, scanner: options.scannerId },
        { status: 'PROCESSING' },
      );

    await expect(store.complete(lease, accepted(lease))).resolves.toBe('stale');
    expect(
      await fixture.admissionDb.getRepository(ObservationEntity).count(),
    ).toBe(0);
    now += options.retryMs;
    await expect(store.claim(1)).resolves.toEqual([]);
  });

  it('checks lease expiry after waiting for the SQLite write lock', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    let now = 8500;
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => now,
    });
    const block = await insertBlock(fixture, 95);
    await store.capture([input(95)], block);
    const [lease] = await store.claim(1);
    const blocker = fixture.scannerDb.createQueryRunner();
    await blocker.connect();
    await blocker.query('BEGIN IMMEDIATE');
    try {
      const completion = store.complete(lease, accepted(lease));
      await Promise.resolve();
      now = lease.expiresAt;
      await blocker.query('COMMIT');
      await expect(completion).resolves.toBe('stale');
    } finally {
      await blocker.release();
    }
    expect(
      await fixture.admissionDb.getRepository(ObservationEntity).count(),
    ).toBe(0);
    await expect(store.claim(1)).resolves.toHaveLength(1);
  });

  it('serializes claims across two SQLite connections so one candidate has one lease', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    const secondAdmissionDb = await openDatabase(fixture.database);
    try {
      const firstStore = new CandidateStore(fixture.admissionDb, {
        ...options,
        now: () => 9000,
      });
      const secondStore = new CandidateStore(secondAdmissionDb, {
        ...options,
        now: () => 9000,
      });
      const block = await insertBlock(fixture, 100);
      await firstStore.capture([input(10)], block);

      const claims = await Promise.all([
        firstStore.claim(1),
        secondStore.claim(1),
      ]);
      expect(claims.flat()).toHaveLength(1);
      expect(new Set(claims.flat().map((lease) => lease.token)).size).toBe(1);
    } finally {
      await secondAdmissionDb.destroy();
    }
  });

  it('counts orphaned evidence against the retained-candidate bound', async () => {
    const fixture = await diskFixture();
    fixtures.push(fixture);
    const store = new CandidateStore(fixture.admissionDb, {
      ...options,
      maxCandidates: 2,
      now: () => 10_000,
    });
    const block = { hash: hex(200), height: 200 };
    await store.capture([input(20)], block);
    await store.forkBlock(block.hash);
    await store.capture([input(21)], block);

    await expect(store.capture([input(22)], block)).rejects.toThrow(
      /retention limit/,
    );
    expect(
      await fixture.admissionDb.getRepository(MoneroCandidateEntity).count(),
    ).toBe(2);
  });

  it('rejects non-disk stores, malformed configuration, IDs, limits, and clocks', async () => {
    const memory = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [],
    });
    expect(() => new CandidateStore(memory, options)).toThrow(/disk-backed/);

    const unopenedDisk = new DataSource({
      type: 'sqlite',
      database: 'unused-candidate-store.sqlite',
      entities: [],
    });
    expect(
      () =>
        new CandidateStore(unopenedDisk, {
          ...options,
          extractorId: undefined as unknown as string,
        }),
    ).toThrow(/extractorId/);
    expect(
      () =>
        new CandidateStore(unopenedDisk, {
          ...options,
          scope: 'A'.repeat(64),
        }),
    ).toThrow(/scope/);
    expect(
      () => new CandidateStore(unopenedDisk, { ...options, maxCandidates: 0 }),
    ).toThrow(/maxCandidates/);
    expect(
      () =>
        new CandidateStore(unopenedDisk, {
          ...options,
          leaseMs: Number.MAX_SAFE_INTEGER,
        }),
    ).toThrow(/leaseMs/);

    const fixture = await diskFixture();
    fixtures.push(fixture);
    const store = new CandidateStore(fixture.admissionDb, options);
    await expect(
      store.capture([{ txId: 'not-hex', transactionHex: 'aa' }], {
        hash: hex(201),
        height: 201,
      }),
    ).rejects.toThrow(/txId/);
    await expect(store.claim(0)).rejects.toThrow(/claim limit/);

    const invalidClock = new CandidateStore(fixture.admissionDb, {
      ...options,
      now: () => Number.NaN,
    });
    await expect(
      invalidClock.capture([input(23)], { hash: hex(202), height: 202 }),
    ).rejects.toThrow(/clock/);
  });
});
