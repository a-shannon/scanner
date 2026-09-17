import { blake2b } from 'blakejs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import {
  DataSource,
  QueryRunner,
  SelectQueryBuilder,
} from '@rosen-bridge/extended-typeorm';
import { BlockInfo } from '@rosen-bridge/scanner-interfaces';

import { MoneroCandidateEntity } from '../entities/moneroCandidateEntity';
import {
  AdmissionResult,
  CandidateLease,
  CandidateStoreOptions,
  MoneroCandidateInput,
} from '../types';

const ID_PATTERN = /^[0-9a-f]{64}$/;
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const MAX_CANDIDATES = 1_000_000;
const MAX_TRANSACTION_BYTES = 32 * 1024 * 1024;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ADDRESS_BYTES = 4096;
const MAX_TOKEN_ID_BYTES = 512;
const MAX_RAW_DATA_BYTES = 1024 * 1024;

type Completion = 'accepted' | 'pending' | 'expired' | 'stale';

interface SerializerState {
  tail: Promise<void>;
}

const sqliteSerializers = new Map<string, SerializerState>();

const runSerialized = async <Result>(
  key: string,
  operation: () => Promise<Result>,
): Promise<Result> => {
  let state = sqliteSerializers.get(key);
  if (!state) {
    state = { tail: Promise.resolve() };
    sqliteSerializers.set(key, state);
  }

  const previous = state.tail.catch(() => undefined);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.then(() => gate);
  state.tail = queued;
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (state.tail === queued) {
      void queued.finally(() => {
        if (sqliteSerializers.get(key) === state && state.tail === queued) {
          sqliteSerializers.delete(key);
        }
      });
    }
  }
};

const assertPositiveInteger = (
  value: number,
  name: string,
  maximum: number,
): void => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
};

const assertHexId = (value: string, name: string): void => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(
      `${name} must be a canonical 32-byte hexadecimal identifier`,
    );
  }
};

const assertBoundedString: (
  value: unknown,
  name: string,
  maximumBytes: number,
  allowEmpty?: boolean,
) => asserts value is string = (
  value,
  name,
  maximumBytes,
  allowEmpty = false,
) => {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error(`${name} is missing or exceeds its bound`);
  }
};

const assertOptions = (options: CandidateStoreOptions): void => {
  if (!options || typeof options !== 'object') {
    throw new Error('CandidateStore options are required');
  }
  if (
    typeof options.extractorId !== 'string' ||
    !COMPONENT_ID_PATTERN.test(options.extractorId)
  ) {
    throw new Error('extractorId is invalid');
  }
  if (
    typeof options.scannerId !== 'string' ||
    !COMPONENT_ID_PATTERN.test(options.scannerId)
  ) {
    throw new Error('scannerId is invalid');
  }
  assertHexId(options.scope, 'scope');
  assertPositiveInteger(options.maxCandidates, 'maxCandidates', MAX_CANDIDATES);
  assertPositiveInteger(
    options.maxTransactionBytes,
    'maxTransactionBytes',
    MAX_TRANSACTION_BYTES,
  );
  assertPositiveInteger(options.leaseMs, 'leaseMs', MAX_DELAY_MS);
  assertPositiveInteger(options.retryMs, 'retryMs', MAX_DELAY_MS);
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new Error('now must be a function');
  }
};

const observationsEqual = (
  existing: ObservationEntity,
  expected: Omit<ObservationEntity, 'id'>,
): boolean =>
  existing.fromChain === expected.fromChain &&
  existing.toChain === expected.toChain &&
  existing.fromAddress === expected.fromAddress &&
  existing.toAddress === expected.toAddress &&
  existing.height === expected.height &&
  existing.amount === expected.amount &&
  existing.networkFee === expected.networkFee &&
  existing.bridgeFee === expected.bridgeFee &&
  existing.sourceChainTokenId === expected.sourceChainTokenId &&
  existing.targetChainTokenId === expected.targetChainTokenId &&
  existing.sourceTxId === expected.sourceTxId &&
  existing.sourceBlockId === expected.sourceBlockId &&
  existing.requestId === expected.requestId &&
  existing.block === expected.block &&
  existing.extractor === expected.extractor &&
  existing.rawData === expected.rawData;

export class CandidateStore {
  readonly options: CandidateStoreOptions;
  private readonly dataSource: DataSource;
  private readonly serializerKey: string;

  constructor(dataSource: DataSource, options: CandidateStoreOptions) {
    if (dataSource.options.type !== 'sqlite') {
      throw new Error('CandidateStore supports SQLite data sources only');
    }
    const database = dataSource.options.database;
    if (
      typeof database !== 'string' ||
      database.length === 0 ||
      database === ':memory:' ||
      /(?:^|[?&])mode=memory(?:&|$)/i.test(database)
    ) {
      throw new Error('CandidateStore requires a disk-backed SQLite database');
    }
    assertOptions(options);

    this.dataSource = dataSource;
    this.options = Object.freeze({ ...options });
    this.serializerKey = resolve(database);
  }

  private currentTime = (): number => {
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error(
        'CandidateStore clock must return a non-negative safe integer',
      );
    }
    return now;
  };

  private futureTime = (now: number, delay: number): number => {
    const result = now + delay;
    if (!Number.isSafeInteger(result)) {
      throw new Error('CandidateStore time exceeds the safe integer range');
    }
    return result;
  };

  private write = async <Result>(
    operation: (queryRunner: QueryRunner) => Promise<Result>,
  ): Promise<Result> =>
    runSerialized(this.serializerKey, async () => {
      if (!this.dataSource.isInitialized) {
        throw new Error('CandidateStore data source is not initialized');
      }
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      let transactionStarted = false;
      try {
        await queryRunner.query('BEGIN IMMEDIATE');
        transactionStarted = true;
        const result = await operation(queryRunner);
        await queryRunner.query('COMMIT');
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted) {
          try {
            await queryRunner.query('ROLLBACK');
          } catch {
            // Preserve the deciding operation failure.
          }
        }
        throw error;
      } finally {
        await queryRunner.release();
      }
    });

  private validateInput = (input: MoneroCandidateInput): void => {
    if (!input || typeof input !== 'object') {
      throw new Error('candidate input is invalid');
    }
    assertHexId(input.txId, 'candidate txId');
    if (
      typeof input.transactionHex !== 'string' ||
      input.transactionHex.length === 0 ||
      input.transactionHex.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(input.transactionHex) ||
      input.transactionHex.length / 2 > this.options.maxTransactionBytes
    ) {
      throw new Error(
        'candidate transactionHex is invalid or exceeds maxTransactionBytes',
      );
    }
  };

  private validateBlock = (block: BlockInfo): void => {
    if (!block || typeof block !== 'object') {
      throw new Error('source block is invalid');
    }
    assertHexId(block.hash, 'source block hash');
    if (!Number.isSafeInteger(block.height) || block.height < 0) {
      throw new Error(
        'source block height must be a non-negative safe integer',
      );
    }
  };

  async capture(
    inputs: MoneroCandidateInput[],
    block: BlockInfo,
  ): Promise<void> {
    if (!Array.isArray(inputs) || inputs.length > this.options.maxCandidates) {
      throw new Error('candidate input batch exceeds maxCandidates');
    }
    this.validateBlock(block);
    inputs.forEach(this.validateInput);
    if (inputs.length === 0) return;

    await this.write(async (queryRunner) => {
      const now = this.currentTime();
      const repository = queryRunner.manager.getRepository(
        MoneroCandidateEntity,
      );
      const retained = await repository.countBy({
        extractorId: this.options.extractorId,
        scope: this.options.scope,
      });
      let novel = 0;

      for (const input of inputs) {
        const existing = await repository.findOneBy({
          extractorId: this.options.extractorId,
          scope: this.options.scope,
          txId: input.txId,
          sourceBlockId: block.hash,
        });
        if (existing) {
          if (
            existing.transactionHex !== input.transactionHex.toLowerCase() ||
            existing.sourceHeight !== block.height ||
            existing.block !== block.hash ||
            existing.scannerId !== this.options.scannerId
          ) {
            throw new Error(
              `candidate conflict for transaction ${input.txId} in block ${block.hash}`,
            );
          }
          if (existing.state === 'orphaned') {
            const updated = await repository
              .createQueryBuilder()
              .update(MoneroCandidateEntity)
              .set({
                state: 'pending',
                revision: () => '"revision" + 1',
                leaseToken: null,
                leaseExpiresAt: null,
                nextAttemptAt: now,
                updatedAt: now,
                observationRequestId: null,
              })
              .where('id = :id', { id: existing.id })
              .andWhere('state = :state', { state: 'orphaned' })
              .andWhere('revision = :revision', {
                revision: existing.revision,
              })
              .execute();
            if (updated.affected !== 1) {
              throw new Error(
                'candidate reactivation lost its compare-and-swap',
              );
            }
          }
          continue;
        }

        novel += 1;
        if (retained + novel > this.options.maxCandidates) {
          throw new Error('candidate retention limit reached');
        }
        await repository.insert({
          extractorId: this.options.extractorId,
          scannerId: this.options.scannerId,
          scope: this.options.scope,
          txId: input.txId,
          transactionHex: input.transactionHex.toLowerCase(),
          sourceBlockId: block.hash,
          block: block.hash,
          sourceHeight: block.height,
          state: 'pending',
          revision: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
          capturedAt: now,
          updatedAt: now,
          observationRequestId: null,
        });
      }
    });
  }

  async claim(limit: number): Promise<CandidateLease[]> {
    assertPositiveInteger(limit, 'claim limit', this.options.maxCandidates);

    return this.write(async (queryRunner) => {
      const now = this.currentTime();
      const expiresAt = this.futureTime(now, this.options.leaseMs);
      const repository = queryRunner.manager.getRepository(
        MoneroCandidateEntity,
      );
      const candidates = await repository
        .createQueryBuilder('candidate')
        .innerJoin(
          BlockEntity,
          'sourceBlock',
          'sourceBlock.hash = candidate.sourceBlockId AND ' +
            'sourceBlock.height = candidate.sourceHeight AND ' +
            'sourceBlock.scanner = :scannerId AND sourceBlock.status = :blockStatus',
          { scannerId: this.options.scannerId, blockStatus: PROCEED },
        )
        .where('candidate.extractorId = :extractorId', {
          extractorId: this.options.extractorId,
        })
        .andWhere('candidate.scannerId = :scannerId', {
          scannerId: this.options.scannerId,
        })
        .andWhere('candidate.scope = :scope', { scope: this.options.scope })
        .andWhere('candidate.state = :state', { state: 'pending' })
        .andWhere('candidate.nextAttemptAt IS NOT NULL')
        .andWhere('candidate.nextAttemptAt <= :now', { now })
        .andWhere(
          '(candidate.leaseToken IS NULL OR candidate.leaseExpiresAt <= :now)',
          { now },
        )
        .orderBy('candidate.nextAttemptAt', 'ASC')
        .addOrderBy('candidate.capturedAt', 'ASC')
        .addOrderBy('candidate.id', 'ASC')
        .limit(limit)
        .getMany();

      const leases: CandidateLease[] = [];
      for (const candidate of candidates) {
        const token = randomBytes(32).toString('hex');
        const update = await repository
          .createQueryBuilder()
          .update(MoneroCandidateEntity)
          .set({
            revision: () => '"revision" + 1',
            leaseToken: token,
            leaseExpiresAt: expiresAt,
            updatedAt: now,
          })
          .where('id = :id', { id: candidate.id })
          .andWhere('state = :state', { state: 'pending' })
          .andWhere('revision = :revision', {
            revision: candidate.revision,
          })
          .andWhere('nextAttemptAt IS NOT NULL AND nextAttemptAt <= :now', {
            now,
          })
          .andWhere('(leaseToken IS NULL OR leaseExpiresAt <= :now)', { now })
          .andWhere(
            `EXISTS (
              SELECT 1 FROM "block_entity" "sourceBlock"
              WHERE "sourceBlock"."hash" = "monero_candidate_entity"."sourceBlockId"
                AND "sourceBlock"."height" = "monero_candidate_entity"."sourceHeight"
                AND "sourceBlock"."scanner" = :scannerId
                AND "sourceBlock"."status" = :blockStatus
            )`,
            { scannerId: this.options.scannerId, blockStatus: PROCEED },
          )
          .execute();
        if (update.affected !== 1) continue;

        leases.push({
          id: candidate.id,
          txId: candidate.txId,
          transactionHex: candidate.transactionHex,
          sourceBlockId: candidate.sourceBlockId,
          sourceHeight: candidate.sourceHeight,
          scope: candidate.scope,
          token,
          revision: candidate.revision + 1,
          expiresAt,
        });
      }
      return leases;
    });
  }

  private assertLeaseMatches = (
    candidate: MoneroCandidateEntity,
    lease: CandidateLease,
  ): boolean =>
    candidate.txId === lease.txId &&
    candidate.transactionHex === lease.transactionHex &&
    candidate.sourceBlockId === lease.sourceBlockId &&
    candidate.sourceHeight === lease.sourceHeight &&
    candidate.scope === lease.scope;

  private validatedObservation = (
    candidate: MoneroCandidateEntity,
    result: Extract<AdmissionResult, { status: 'accepted' }>,
  ): Omit<ObservationEntity, 'id'> => {
    const observation = result.observation;
    if (!observation || typeof observation !== 'object') {
      throw new Error('accepted result has no observation');
    }
    if (observation.fromChain !== 'monero') {
      throw new Error('accepted observation must originate from Monero');
    }
    assertBoundedString(observation.toChain, 'observation.toChain', 30);
    assertBoundedString(
      observation.fromAddress,
      'observation.fromAddress',
      MAX_ADDRESS_BYTES,
    );
    assertBoundedString(
      observation.toAddress,
      'observation.toAddress',
      MAX_ADDRESS_BYTES,
    );
    assertBoundedString(
      observation.sourceChainTokenId,
      'observation.sourceChainTokenId',
      MAX_TOKEN_ID_BYTES,
      true,
    );
    assertBoundedString(
      observation.targetChainTokenId,
      'observation.targetChainTokenId',
      MAX_TOKEN_ID_BYTES,
      true,
    );
    assertBoundedString(
      observation.rawData,
      'observation.rawData',
      MAX_RAW_DATA_BYTES,
      true,
    );
    for (const [name, value] of [
      ['amount', observation.amount],
      ['networkFee', observation.networkFee],
      ['bridgeFee', observation.bridgeFee],
    ] as const) {
      if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
        throw new Error(
          `observation.${name} must be a bounded canonical unsigned integer`,
        );
      }
    }
    if (observation.sourceTxId !== candidate.txId) {
      throw new Error(
        'accepted observation sourceTxId does not bind the candidate',
      );
    }
    if (observation.sourceBlockId !== candidate.sourceBlockId) {
      throw new Error(
        'accepted observation sourceBlockId does not bind the candidate',
      );
    }
    const requestId = Buffer.from(
      blake2b(candidate.txId, undefined, 32),
    ).toString('hex');
    if (observation.requestId !== requestId) {
      throw new Error(
        'accepted observation requestId does not bind the candidate transaction',
      );
    }

    return {
      fromChain: observation.fromChain,
      toChain: observation.toChain,
      fromAddress: observation.fromAddress,
      toAddress: observation.toAddress,
      height: candidate.sourceHeight,
      amount: observation.amount,
      networkFee: observation.networkFee,
      bridgeFee: observation.bridgeFee,
      sourceChainTokenId: observation.sourceChainTokenId,
      targetChainTokenId: observation.targetChainTokenId,
      sourceTxId: observation.sourceTxId,
      sourceBlockId: observation.sourceBlockId,
      requestId: observation.requestId,
      block: candidate.block,
      extractor: this.options.extractorId,
      rawData: observation.rawData,
    };
  };

  async complete(
    lease: CandidateLease,
    result: AdmissionResult,
  ): Promise<Completion> {
    if (
      !lease ||
      typeof lease !== 'object' ||
      !Number.isSafeInteger(lease.id) ||
      lease.id <= 0
    ) {
      throw new Error('candidate lease is invalid');
    }
    assertHexId(lease.txId, 'lease txId');
    assertHexId(lease.sourceBlockId, 'lease sourceBlockId');
    assertHexId(lease.scope, 'lease scope');
    assertHexId(lease.token, 'lease token');
    if (
      !Number.isSafeInteger(lease.sourceHeight) ||
      lease.sourceHeight < 0 ||
      !Number.isSafeInteger(lease.revision) ||
      lease.revision <= 0 ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt < 0
    ) {
      throw new Error('candidate lease counters or times are invalid');
    }
    this.validateInput(lease);
    if (
      !result ||
      typeof result !== 'object' ||
      !['accepted', 'pending', 'expired'].includes(result.status)
    ) {
      throw new Error('admission result is invalid');
    }

    return this.write(async (queryRunner) => {
      const now = this.currentTime();
      const repository = queryRunner.manager.getRepository(
        MoneroCandidateEntity,
      );
      const candidate = await repository.findOneBy({
        id: lease.id,
        extractorId: this.options.extractorId,
        scannerId: this.options.scannerId,
        scope: this.options.scope,
      });
      if (
        !candidate ||
        candidate.state !== 'pending' ||
        !this.assertLeaseMatches(candidate, lease) ||
        candidate.leaseToken !== lease.token ||
        candidate.revision !== lease.revision ||
        candidate.leaseExpiresAt !== lease.expiresAt
      ) {
        return 'stale';
      }

      if (candidate.leaseExpiresAt <= now) {
        await repository.update(
          {
            id: candidate.id,
            state: 'pending',
            revision: candidate.revision,
            leaseToken: candidate.leaseToken,
            leaseExpiresAt: candidate.leaseExpiresAt,
          },
          {
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: now,
            updatedAt: now,
          },
        );
        return 'stale';
      }

      const sourceBlock = await queryRunner.manager
        .getRepository(BlockEntity)
        .findOneBy({
          hash: candidate.sourceBlockId,
          height: candidate.sourceHeight,
          scanner: this.options.scannerId,
          status: PROCEED,
        });
      if (!sourceBlock) {
        const retryAt = this.futureTime(now, this.options.retryMs);
        await repository.update(
          {
            id: candidate.id,
            state: 'pending',
            revision: candidate.revision,
            leaseToken: candidate.leaseToken,
            leaseExpiresAt: candidate.leaseExpiresAt,
          },
          {
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: retryAt,
            updatedAt: now,
          },
        );
        return 'stale';
      }

      if (result.status === 'pending') {
        const retryAt = this.futureTime(now, this.options.retryMs);
        const update = await repository.update(
          {
            id: candidate.id,
            state: 'pending',
            revision: candidate.revision,
            leaseToken: candidate.leaseToken,
            leaseExpiresAt: candidate.leaseExpiresAt,
          },
          {
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: retryAt,
            updatedAt: now,
          },
        );
        return update.affected === 1 ? 'pending' : 'stale';
      }

      if (result.status === 'expired') {
        const update = await repository.update(
          {
            id: candidate.id,
            state: 'pending',
            revision: candidate.revision,
            leaseToken: candidate.leaseToken,
            leaseExpiresAt: candidate.leaseExpiresAt,
          },
          {
            state: 'expired',
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            updatedAt: now,
          },
        );
        return update.affected === 1 ? 'expired' : 'stale';
      }

      const observation = this.validatedObservation(candidate, result);
      const observationRepository =
        queryRunner.manager.getRepository(ObservationEntity);
      const existing = await observationRepository.findOneBy({
        requestId: observation.requestId,
        extractor: this.options.extractorId,
      });
      if (existing) {
        if (!observationsEqual(existing, observation)) {
          throw new Error(
            'accepted observation conflicts with retained observation',
          );
        }
      } else {
        await observationRepository.insert(observation);
      }

      const update = await repository.update(
        {
          id: candidate.id,
          state: 'pending',
          revision: candidate.revision,
          leaseToken: candidate.leaseToken,
          leaseExpiresAt: candidate.leaseExpiresAt,
        },
        {
          state: 'accepted',
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          updatedAt: now,
          observationRequestId: observation.requestId,
        },
      );
      if (update.affected !== 1) {
        throw new Error('accepted candidate lost its compare-and-swap');
      }
      return 'accepted';
    });
  }

  async forkBlock(hash: string): Promise<void> {
    assertHexId(hash, 'fork block hash');
    await this.write(async (queryRunner) => {
      const now = this.currentTime();
      const repository = queryRunner.manager.getRepository(
        MoneroCandidateEntity,
      );
      const candidates = await repository.findBy({
        extractorId: this.options.extractorId,
        scannerId: this.options.scannerId,
        scope: this.options.scope,
        sourceBlockId: hash,
      });
      const requestIds = candidates
        .map((candidate) => candidate.observationRequestId)
        .filter((requestId): requestId is string => requestId !== null);

      if (requestIds.length > 0) {
        await queryRunner.manager
          .getRepository(ObservationEntity)
          .createQueryBuilder()
          .delete()
          .where('extractor = :extractorId', {
            extractorId: this.options.extractorId,
          })
          .andWhere('block = :hash', { hash })
          .andWhere('sourceBlockId = :hash', { hash })
          .andWhere('requestId IN (:...requestIds)', { requestIds })
          .execute();
      }

      await repository
        .createQueryBuilder()
        .update(MoneroCandidateEntity)
        .set({
          state: 'orphaned',
          revision: () => '"revision" + 1',
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where('extractorId = :extractorId', {
          extractorId: this.options.extractorId,
        })
        .andWhere('scannerId = :scannerId', {
          scannerId: this.options.scannerId,
        })
        .andWhere('scope = :scope', { scope: this.options.scope })
        .andWhere('sourceBlockId = :hash', { hash })
        .andWhere('state != :state', { state: 'orphaned' })
        .execute();
    });
  }

  createUsedBlocksQuery(): SelectQueryBuilder<MoneroCandidateEntity> {
    return this.dataSource
      .getRepository(MoneroCandidateEntity)
      .createQueryBuilder('candidate')
      .select('candidate.block', 'block')
      .where('candidate.extractorId = :candidateExtractorId', {
        candidateExtractorId: this.options.extractorId,
      })
      .andWhere('candidate.scannerId = :candidateScannerId', {
        candidateScannerId: this.options.scannerId,
      })
      .andWhere('candidate.scope = :candidateScope', {
        candidateScope: this.options.scope,
      })
      .andWhere('candidate.state != :candidateOrphaned', {
        candidateOrphaned: 'orphaned',
      });
  }
}
