import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlockEntity, PROCEED } from '@rosen-bridge/abstract-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { Block } from '@rosen-bridge/scanner-interfaces';

import {
  AvalancheRpcNetwork,
  AvalancheRpcValidationError,
} from '../lib/avalancheRpcNetwork';
import {
  AvalancheRpcScanner,
  AvalancheScannerConfig,
} from '../lib/avalancheRpcScanner';
import { AvalancheSafetyState } from '../lib/avalancheSafetyState';
import { block, hash, openDatabase } from './avalancheScannerTestUtils';
import { mockScannerNetwork } from './mocked/avalancheScannerNetwork.mock';

describe('AvalancheRpcScanner', () => {
  let database: DataSource;

  let databasePath: string;

  let network: AvalancheRpcNetwork;

  let config: AvalancheScannerConfig;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `avalanche-scanner-${randomUUID()}.sqlite`);
    database = await openDatabase(databasePath);
    network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
    mockScannerNetwork(network);
    config = {
      dataSource: database,
      network,
      initialHeight: 0,
      sourceId: 'operator-fuji-a',
      blockCleanupConfig: {
        blockCleanupThresholdDuration: 86400,
        blockTrimCountInRound: 2000,
      },
    };
  });

  afterEach(async () => {
    network['provider'].destroy();
    if (database.isInitialized) await database.destroy();
    unlinkSync(databasePath);
    vi.restoreAllMocks();
  });

  describe('update', () => {
    /**
     * @target AvalancheRpcScanner.update processes contiguous settled blocks
     * and persists identity and frontier
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Scan settled blocks 1 through 3 using a fresh SQLite database.
     * @expected
     * - Blocks and chain/source/policy/frontier persist with no hold.
     */
    it('processes contiguous settled blocks and persists identity and frontier', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      expect(
        await database
          .getRepository(BlockEntity)
          .find({ order: { height: 'ASC' } }),
      ).toEqual(
        [1, 2, 3].map((height) =>
          expect.objectContaining({
            height,
            hash: hash(height),
            status: PROCEED,
          }),
        ),
      );
      expect(
        await database
          .getRepository(AvalancheSafetyState)
          .findOneByOrFail({ scanner: 'avalanche' }),
      ).toMatchObject({
        chainId: '43113',
        sourceId: 'operator-fuji-a',
        policy: 'helicon-settled-v1',
        finalizedHeight: 3,
        finalizedHash: hash(3),
        holdReason: null,
      });
      expect(scanner.getBlockChainLastHeight()).toEqual(3);
    });

    /**
     * @target AvalancheRpcScanner.update preserves blocks and the hold across
     * a database close and restart
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Scan blocks, introduce a hash conflict, close and reopen SQLite, then
     * retry.
     * @expected
     * - History remains unchanged and the durable hold prevents further RPC.
     */
    it('preserves blocks and the hold across a database close and restart', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      const original = await database.getRepository(BlockEntity).find();
      vi.mocked(network.getBlockAtHeight).mockImplementation(
        async (height) => ({
          ...block(height),
          hash: hash(100 + height),
        }),
      );
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('settled-frontier-conflict');
      expect(await database.getRepository(BlockEntity).find()).toEqual(
        original,
      );
      await database.destroy();
      database = await openDatabase(databasePath);
      vi.mocked(network.getBlockAtHeight).mockImplementation(async (height) =>
        block(height),
      );
      vi.mocked(network.getCurrentHeight).mockClear();
      await expect(async () => {
        await new AvalancheRpcScanner({
          ...config,
          dataSource: database,
        }).update();
      }).rejects.toThrow('scanner held');
      expect(network.getCurrentHeight).not.toHaveBeenCalled();
      expect(await database.getRepository(BlockEntity).find()).toEqual(
        original,
      );
    });

    /**
     * @target AvalancheRpcScanner.update holds on changed persisted %s
     * identity before querying the network
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Persist initial history, change one identity field, then restart
     * scanning.
     * @expected
     * - Identity validation rejects before querying the network.
     */
    it.each([
      ['source', { sourceId: 'operator-fuji-b' }],
      ['policy', undefined],
      ['chain', undefined],
    ] as const)(
      'holds on changed persisted %s identity before querying the network',
      async (kind, override) => {
        await new AvalancheRpcScanner(config).update();
        if (kind !== 'source')
          await database
            .getRepository(AvalancheSafetyState)
            .update(
              { scanner: 'avalanche' },
              kind === 'policy'
                ? { policy: 'different-policy' }
                : { chainId: '43114' },
            );
        vi.mocked(network.getCurrentHeight).mockClear();
        await expect(async () => {
          await new AvalancheRpcScanner({ ...config, ...override }).update();
        }).rejects.toThrow('scanner-identity-changed');
        expect(network.getCurrentHeight).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheRpcScanner.update holds on a regressing settled
     * frontier
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Scan through height 3, then report a settled height of 2.
     * @expected
     * - The regressing frontier rejects.
     */
    it('holds on a regressing settled frontier', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      vi.mocked(network.getCurrentHeight).mockResolvedValue(2);
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('settled-frontier-regressed');
    });

    /**
     * @target AvalancheRpcScanner.update holds on a discontinuous parent
     * before extracting the next block
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Scan through height 3, then return a conflicting parent for height 4.
     * @expected
     * - The update rejects before extraction and preserves three blocks.
     */
    it('holds on a discontinuous parent before extracting the next block', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      vi.mocked(network.getCurrentHeight).mockResolvedValue(4);
      vi.mocked(network.getBlockAtHeight).mockImplementation(
        async (height) => ({
          ...block(height),
          parentHash: height === 4 ? hash(99) : hash(height - 1),
        }),
      );
      vi.mocked(network.getBlockTxs).mockClear();
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('settled-parent-conflict');
      expect(network.getBlockTxs).not.toHaveBeenCalled();
      expect(await database.getRepository(BlockEntity).count()).toEqual(3);
    });

    /**
     * @target AvalancheRpcScanner.update retries an unavailable provider
     * without clearing history or recording a contradiction
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Scan history, reject one height query as unavailable, then retry.
     * @expected
     * - The error propagates without a persistent contradiction hold.
     */
    it('retries an unavailable provider without clearing history or recording a contradiction', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      vi.mocked(network.getCurrentHeight).mockRejectedValueOnce(
        new Error('provider unavailable'),
      );
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('provider unavailable');
      expect(
        (
          await database
            .getRepository(AvalancheSafetyState)
            .findOneByOrFail({ scanner: 'avalanche' })
        ).holdReason,
      ).toBeNull();
      await scanner.update();
    });

    /**
     * @target AvalancheRpcScanner.update preserves a partially extracted block
     * when its identity changes on restart
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Fail first-block extraction, restart, and return a changed first-block
     * identity.
     * @expected
     * - Partial history remains, extraction is skipped and a hold persists.
     */
    it('preserves a partially extracted block when its identity changes on restart', async () => {
      const scanner = new AvalancheRpcScanner(config);
      const extractor = {
        getId: () => 'synthetic-extractor',
        processTransactions: vi.fn().mockResolvedValue(false),
        initializeData: vi.fn().mockResolvedValue(undefined),
        forkBlock: vi.fn().mockResolvedValue(undefined),
        createUsedBlocksQuery: () => [],
        hasEventInHeightRange: async () => true,
      };
      await scanner.registerExtractor(extractor);
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('extraction incomplete');
      const original = await database
        .getRepository(BlockEntity)
        .findOneByOrFail({ height: 1, scanner: 'avalanche' });
      expect(original.status).toEqual('PROCESSING');
      const restarted = new AvalancheRpcScanner(config);
      await restarted.registerExtractor(extractor);
      extractor.processTransactions.mockClear().mockResolvedValue(true);
      vi.mocked(network.getBlockAtHeight).mockImplementation(
        async (height) => ({
          ...block(height),
          hash: height === 1 ? hash(101) : hash(height),
          parentHash: height === 2 ? hash(101) : hash(height - 1),
        }),
      );
      await expect(async () => {
        await restarted.update();
      }).rejects.toThrow('persisted-block-conflict');
      expect(extractor.processTransactions).not.toHaveBeenCalled();
      expect(await database.getRepository(BlockEntity).find()).toEqual([
        original,
      ]);
      expect(
        (
          await database
            .getRepository(AvalancheSafetyState)
            .findOneByOrFail({ scanner: 'avalanche' })
        ).holdReason,
      ).not.toBeNull();
    });

    /**
     * @target AvalancheRpcScanner.update does not skip a partial first block
     * after the initial-height policy changes
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Persist a partial first block, then restart with a changed initial
     * height.
     * @expected
     * - Identity validation rejects before RPC and preserves the partial
     * block.
     */
    it('does not skip a partial first block after the initial-height policy changes', async () => {
      const scanner = new AvalancheRpcScanner(config);
      vi.spyOn(
        scanner as unknown as {
          processBlock: (block: Block) => Promise<false>;
        },
        'processBlock',
      ).mockImplementationOnce(async () => {
        await database
          .getRepository(BlockEntity)
          .save({ ...block(1), scanner: 'avalanche', status: 'PROCESSING' });
        return false;
      });
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('extraction incomplete');
      const original = await database.getRepository(BlockEntity).find();
      vi.mocked(network.getCurrentHeight).mockClear();
      await expect(async () => {
        await new AvalancheRpcScanner({ ...config, initialHeight: 1 }).update();
      }).rejects.toThrow('scanner-identity-changed');
      expect(network.getCurrentHeight).not.toHaveBeenCalled();
      expect(await database.getRepository(BlockEntity).find()).toEqual(
        original,
      );
    });

    /**
     * @target AvalancheRpcScanner.update does not extract a frontier that
     * changes after the captured checkpoint
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Change the frontier hash between checkpoint capture and its later
     * read.
     * @expected
     * - Conflicting extraction is skipped and only two blocks persist.
     */
    it('does not extract a frontier that changes after the captured checkpoint', async () => {
      let reads = 0;
      vi.mocked(network.getBlockAtHeight).mockImplementation(async (height) => {
        if (height === 3 && ++reads === 2)
          return { ...block(height), hash: hash(103) };
        return block(height);
      });
      await expect(async () => {
        await new AvalancheRpcScanner(config).update();
      }).rejects.toThrow('settled-response-conflict');
      expect(network.getBlockTxs).not.toHaveBeenCalledWith(hash(103), 3);
      expect(await database.getRepository(BlockEntity).count()).toEqual(2);
    });

    /**
     * @target AvalancheRpcScanner.update holds on a typed RPC contradiction
     * before storing a block
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Reject the height query with AvalancheRpcValidationError.
     * @expected
     * - No block is stored and the contradiction hold persists.
     */
    it('holds on a typed RPC contradiction before storing a block', async () => {
      vi.mocked(network.getCurrentHeight).mockRejectedValue(
        new AvalancheRpcValidationError('wrong-chain'),
      );
      await expect(async () => {
        await new AvalancheRpcScanner(config).update();
      }).rejects.toThrow('wrong-chain');
      expect(await database.getRepository(BlockEntity).count()).toEqual(0);
      expect(
        (
          await database
            .getRepository(AvalancheSafetyState)
            .findOneByOrFail({ scanner: 'avalanche' })
        ).holdReason,
      ).not.toBeNull();
    });

    /**
     * @target AvalancheRpcScanner.update refuses to reinterpret pre-existing
     * unqualified scanner history
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Insert processed history without qualified safety state and start
     * scanning.
     * @expected
     * - The scanner rejects unqualified history before RPC.
     */
    it('refuses to reinterpret pre-existing unqualified scanner history', async () => {
      await database
        .getRepository(BlockEntity)
        .save({ ...block(1), scanner: 'avalanche', status: PROCEED });
      await expect(async () => {
        await new AvalancheRpcScanner(config).update();
      }).rejects.toThrow('unqualified-existing-history');
      expect(network.getCurrentHeight).not.toHaveBeenCalled();
    });
  });

  describe('assertUsable', () => {
    /**
     * @target AvalancheRpcScanner.assertUsable rejects uninitialized and held
     * scanner state
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork and synthetic contiguous blocks.
     * @scenario
     * - Request usability before scanning.
     * - Scan through the finalized frontier and request usability again.
     * - Persist a hold and repeat the usability check.
     * @expected
     * - Only the initialized scanner without a hold is usable.
     */
    it('rejects uninitialized and held scanner state', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await expect(async () => {
        await scanner.assertUsable();
      }).rejects.toThrow('not qualified');
      await scanner.update();
      await scanner.assertUsable();
      await database
        .getRepository(AvalancheSafetyState)
        .update({ scanner: 'avalanche' }, { holdReason: 'synthetic-hold' });
      await expect(async () => {
        await scanner.assertUsable();
      }).rejects.toThrow('not qualified');
    });
  });

  describe('assertObservation', () => {
    /**
     * @target AvalancheRpcScanner.assertObservation gates downstream consumers
     * on initialization, matching block and persisted hold
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Check before initialization, scan, alter block status, then persist a
     * hold.
     * @expected
     * - Only a matching processed observation in qualified state is usable.
     */
    it('gates downstream consumers on initialization, matching block and persisted hold', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await expect(async () => {
        await scanner.assertObservation(1, hash(1));
      }).rejects.toThrow('not qualified');
      await scanner.update();
      await scanner.assertObservation(1, hash(1));
      await expect(async () => {
        await scanner.assertObservation(1, hash(101));
      }).rejects.toThrow('no matching');
      await expect(async () => {
        await scanner.assertObservation(4, hash(4));
      }).rejects.toThrow('no matching');
      await database
        .getRepository(BlockEntity)
        .update({ height: 1, scanner: 'avalanche' }, { status: 'PROCESSING' });
      await expect(async () => {
        await scanner.assertObservation(1, hash(1));
      }).rejects.toThrow('no matching');
      await database
        .getRepository(AvalancheSafetyState)
        .update({ scanner: 'avalanche' }, { holdReason: 'synthetic-hold' });
      await expect(async () => {
        await scanner.assertObservation(2, hash(2));
      }).rejects.toThrow('not qualified');
    });
  });

  describe('withObservation', () => {
    /**
     * @target AvalancheRpcScanner.withObservation does not invoke an
     * observation action while %s
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Leave the scanner unqualified or persist a hold
     * - submit an action.
     * @expected
     * - The observation action is rejected and never invoked.
     */
    it.each(['unqualified', 'held'] as const)(
      'does not invoke an observation action while %s',
      async (state) => {
        const scanner = new AvalancheRpcScanner(config);
        if (state === 'held') {
          await scanner.update();
          await database
            .getRepository(AvalancheSafetyState)
            .update({ scanner: 'avalanche' }, { holdReason: 'synthetic-hold' });
        }
        const action = vi.fn();
        await expect(async () => {
          await scanner.withObservation(1, hash(1), action);
        }).rejects.toThrow('not qualified');
        expect(action).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheRpcScanner.withObservation rejects an observation
     * action during an update
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Pause an update in its height query, then request an observation
     * action.
     * @expected
     * - The action is excluded until the update finishes.
     */
    it('rejects an observation action during an update', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let finish!: (height: number) => void;
      vi.mocked(network.getCurrentHeight).mockReturnValueOnce(
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
      );
      const updating = scanner.update();
      const action = vi.fn();
      await expect(async () => {
        await scanner.withObservation(1, hash(1), action);
      }).rejects.toThrow('already running');
      expect(action).not.toHaveBeenCalled();
      finish(3);
      await updating;
    });

    /**
     * @target AvalancheRpcScanner.withObservation rejects an update before RPC
     * while an observation action is pending
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Pause a consuming observation action, attempt an update, then finish
     * it.
     * @expected
     * - RPC is excluded during consumption and resumes after completion.
     */
    it('rejects an update before RPC while an observation action is pending', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let finish!: (value: string) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const consuming = scanner.withObservation(1, hash(1), () => {
        entered();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      });
      await started;
      vi.mocked(network.getCurrentHeight).mockClear();
      vi.mocked(network.getBlockAtHeight).mockClear();
      vi.mocked(network.getBlockTxs).mockClear();
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('already running');
      expect(network.getCurrentHeight).not.toHaveBeenCalled();
      expect(network.getBlockAtHeight).not.toHaveBeenCalled();
      expect(network.getBlockTxs).not.toHaveBeenCalled();
      finish('completed');
      await expect(consuming).resolves.toEqual('completed');
      await scanner.update();
      expect(network.getCurrentHeight).toHaveBeenCalledOnce();
    });

    /**
     * @target AvalancheRpcScanner.withObservation excludes a second consumer
     * before the first validation awaits
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Start the first observation action and immediately submit a second.
     * @expected
     * - The second is excluded before the first validation await finishes.
     */
    it('excludes a second consumer before the first validation awaits', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      const first = vi.fn().mockReturnValue('first');
      const second = vi.fn();
      const consuming = scanner.withObservation(1, hash(1), first);
      await expect(async () => {
        await scanner.withObservation(1, hash(1), second);
      }).rejects.toThrow('already running');
      expect(second).not.toHaveBeenCalled();
      await expect(consuming).resolves.toEqual('first');
      expect(first).toHaveBeenCalledOnce();
    });

    /**
     * @target AvalancheRpcScanner.withObservation releases exclusion after a
     * %s action failure
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Throw or reject inside the action, then update and invoke another
     * action.
     * @expected
     * - The exact failure propagates and exclusion is released for recovery.
     */
    it.each(['synchronous', 'asynchronous'] as const)(
      'releases exclusion after a %s action failure',
      async (kind) => {
        const scanner = new AvalancheRpcScanner(config);
        await scanner.update();
        const failure = new Error('synthetic-action-failure');
        await expect(
          scanner.withObservation(1, hash(1), () => {
            if (kind === 'asynchronous') return Promise.reject(failure);
            throw failure;
          }),
        ).rejects.toBe(failure);
        await scanner.update();
        await expect(
          scanner.withObservation(1, hash(1), () => 'recovered'),
        ).resolves.toEqual('recovered');
      },
    );

    /**
     * @target AvalancheRpcScanner.withObservation releases exclusion after
     * observation validation fails
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Reject an incorrect observation hash, then update and use the correct
     * hash.
     * @expected
     * - The first action is not invoked; the later valid action returns 42.
     */
    it('releases exclusion after observation validation fails', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      const action = vi.fn();
      await expect(async () => {
        await scanner.withObservation(1, hash(101), action);
      }).rejects.toThrow('no matching');
      expect(action).not.toHaveBeenCalled();
      await scanner.update();
      await expect(
        scanner.withObservation(1, hash(1), () => 42),
      ).resolves.toEqual(42);
    });
  });

  describe('withSafety', () => {
    /**
     * @target AvalancheRpcScanner.withSafety releases the safety exclusion
     * after rejecting uninitialized state
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Request safety before initialization, then scan and retry.
     * @expected
     * - The first action is skipped and the qualified retry runs once.
     */
    it('releases the safety exclusion after rejecting uninitialized state', async () => {
      const scanner = new AvalancheRpcScanner(config);
      const action = vi.fn().mockReturnValue('qualified');
      await expect(async () => {
        await scanner.withSafety(action);
      }).rejects.toThrow('not qualified');
      expect(action).not.toHaveBeenCalled();
      await scanner.update();
      await expect(scanner.withSafety(action)).resolves.toEqual('qualified');
      expect(action).toHaveBeenCalledOnce();
    });

    /**
     * @target AvalancheRpcScanner.withSafety does not invoke a safety action
     * with unqualified persisted state %j
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Scan initial history, mutate one persisted qualification field, and
     * submit an action.
     * @expected
     * - The unqualified state rejects without invoking the action.
     */
    it.each([
      { holdReason: 'synthetic-hold' },
      { sourceId: 'other-source' },
      { chainId: '43114' },
      { policy: 'other-policy' },
      { initialHeight: 1 },
      { finalizedHeight: null },
      { finalizedHash: null },
    ])(
      'does not invoke a safety action with unqualified persisted state %j',
      async (override) => {
        const scanner = new AvalancheRpcScanner(config);
        await scanner.update();
        await database
          .getRepository(AvalancheSafetyState)
          .update({ scanner: 'avalanche' }, override);
        const action = vi.fn();
        await expect(async () => {
          await scanner.withSafety(action);
        }).rejects.toThrow('not qualified');
        expect(action).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheRpcScanner.withSafety rejects a safety action during an
     * update
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Pause an update, request safety, then finish the update and retry.
     * @expected
     * - The first action is excluded and the later action runs once.
     */
    it('rejects a safety action during an update', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let finish!: (height: number) => void;
      vi.mocked(network.getCurrentHeight).mockReturnValueOnce(
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
      );
      const updating = scanner.update();
      const action = vi.fn();
      await expect(async () => {
        await scanner.withSafety(action);
      }).rejects.toThrow('already running');
      expect(action).not.toHaveBeenCalled();
      finish(3);
      await updating;
      await scanner.withSafety(action);
      expect(action).toHaveBeenCalledOnce();
    });

    /**
     * @target AvalancheRpcScanner.withSafety acquires safety exclusion before
     * its first await
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Start a safety action and immediately submit a second action.
     * @expected
     * - The second is excluded before the first await; the first returns 42.
     */
    it('acquires safety exclusion before its first await', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      const action = vi.fn();
      const consuming = scanner.withSafety(() => 42);
      await expect(async () => {
        await scanner.withSafety(action);
      }).rejects.toThrow('already running');
      expect(action).not.toHaveBeenCalled();
      await expect(consuming).resolves.toEqual(42);
    });

    /**
     * @target AvalancheRpcScanner.withSafety holds safety exclusion through
     * async completion against updates and reentrant consumers
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Pause a safety action
     * - attempt an update and both consumer routes
     * - then finish.
     * @expected
     * - RPC and actions remain excluded until completion, then recover.
     */
    it('holds safety exclusion through async completion against updates and reentrant consumers', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let finish!: (value: string) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const consuming = scanner.withSafety(() => {
        entered();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      });
      await started;
      vi.mocked(network.getCurrentHeight).mockClear();
      vi.mocked(network.getBlockAtHeight).mockClear();
      vi.mocked(network.getBlockTxs).mockClear();
      const action = vi.fn();
      await expect(async () => {
        await scanner.update();
      }).rejects.toThrow('already running');
      await expect(async () => {
        await scanner.withSafety(action);
      }).rejects.toThrow('already running');
      await expect(async () => {
        await scanner.withObservation(1, hash(1), action);
      }).rejects.toThrow('already running');
      expect(action).not.toHaveBeenCalled();
      expect(network.getCurrentHeight).not.toHaveBeenCalled();
      expect(network.getBlockAtHeight).not.toHaveBeenCalled();
      expect(network.getBlockTxs).not.toHaveBeenCalled();
      finish('completed');
      await expect(consuming).resolves.toEqual('completed');
      await scanner.update();
      await scanner.withObservation(1, hash(1), action);
      expect(action).toHaveBeenCalledOnce();
    });

    /**
     * @target AvalancheRpcScanner.withSafety releases safety exclusion after a
     * %s action failure
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Throw or reject inside a safety action, then update and run another
     * action.
     * @expected
     * - The exact failure propagates and a later action succeeds.
     */
    it.each(['synchronous', 'asynchronous'] as const)(
      'releases safety exclusion after a %s action failure',
      async (kind) => {
        const scanner = new AvalancheRpcScanner(config);
        await scanner.update();
        const failure = new Error('synthetic-action-failure');
        await expect(
          scanner.withSafety(() => {
            if (kind === 'asynchronous') return Promise.reject(failure);
            throw failure;
          }),
        ).rejects.toBe(failure);
        await scanner.update();
        await expect(scanner.withSafety(() => 'recovered')).resolves.toEqual(
          'recovered',
        );
      },
    );
  });

  describe('constructor', () => {
    /**
     * @target AvalancheRpcScanner.constructor rejects an invalid scanner
     * configuration
     * @dependencies
     * - Temporary SQLite database and scanner migrations.
     * - Spies on AvalancheRpcNetwork; synthetic blocks and action callbacks.
     * @scenario
     * - Construct a scanner with each invalid configuration override.
     * @expected
     * - Invalid scanner configuration rejects.
     */
    it.each([
      { sourceId: 'https://provider.example/token' },
      { sourceId: '' },
      { heightGap: 2 },
      { suffix: 'different-state' },
      { initialHeight: 1.5 },
      { initialHeight: -2 },
    ])('rejects an invalid scanner configuration', (override) => {
      expect(() => new AvalancheRpcScanner({ ...config, ...override })).toThrow(
        Error,
      );
    });
  });
  describe('withHealthRead', () => {
    /**
     * @target AvalancheRpcScanner.withHealthRead rechecks qualification when a queued read is admitted
     * @dependencies SQLite scanner state and a held read.
     * @scenario Queue a read, change persisted qualification, then release its predecessor.
     * @expected The queued callback refuses the changed state and never publishes its result.
     */
    it('rechecks qualification when a queued read is admitted', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const first = scanner.withHealthRead(
        async () => {
          entered();
          await gate;
        },
        1000,
        2,
      );
      await started;
      const action = vi.fn();
      const queued = scanner.withHealthRead(action, 1000, 2);
      const refusal = expect(queued).rejects.toThrow('not qualified');
      try {
        await database
          .getRepository(AvalancheSafetyState)
          .update({ scanner: 'avalanche' }, { holdReason: 'fixture-drift' });
      } finally {
        release();
      }
      await first;
      await refusal;
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheRpcScanner.withHealthRead refuses an update admitted before health acquisition
     * @dependencies SQLite state, actual Mutex scheduling and held scanner RPC.
     * @scenario Request health then synchronously start an update before Mutex admission.
     * @expected Update retains its lease; health refuses without callback invocation and later recovers.
     */
    it('refuses an update admitted before health acquisition', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      vi.mocked(network.getCurrentHeight).mockImplementationOnce(async () => {
        entered();
        await gate;
        return 3;
      });
      const action = vi.fn(),
        read = scanner.withHealthRead(action, 1000, 2);
      const refusal = expect(read).rejects.toThrow('already running');
      const updating = scanner.update();
      try {
        await started;
        await refusal;
        expect(action).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await updating;
      await expect(scanner.withHealthRead(() => 42, 1000, 2)).resolves.toEqual(
        42,
      );
    });

    /**
     * @target AvalancheRpcScanner.withHealthRead serializes health reads and retains exclusive action admission
     * @dependencies SQLite scanner state and held read callbacks.
     * @scenario Start two health reads while the first is held; attempt an exclusive action and update.
     * @expected Reads complete in order; exclusive actions and updates refuse until the lease ends.
     */
    it('serializes health reads and retains exclusive action admission', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const order: number[] = [];
      const first = scanner.withHealthRead(
        async () => {
          order.push(1);
          entered();
          await gate;
          return 1;
        },
        1000,
        3,
      );
      await started;
      const second = scanner.withHealthRead(
        () => {
          order.push(2);
          return 2;
        },
        1000,
        3,
      );
      const action = vi.fn();
      try {
        await expect(scanner.withSafety(action)).rejects.toThrow(
          'already running',
        );
        await expect(
          scanner.withObservation(1, hash(1), action),
        ).rejects.toThrow('already running');
        await expect(scanner.update()).rejects.toThrow('already running');
        expect(order).toEqual([1]);
        expect(action).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
      expect(order).toEqual([1, 2]);
      await scanner.update();
    });

    /**
     * @target AvalancheRpcScanner.withHealthRead refuses health reads during an existing %s operation
     * @dependencies SQLite state and a held exclusive action or scanner RPC.
     * @scenario Admit an update or exclusive consumer before requesting health.
     * @expected Health callback is never invoked, then admission recovers after completion.
     */
    it.each(['update', 'consumer'] as const)(
      'refuses health reads during an existing %s operation',
      async (kind) => {
        const scanner = new AvalancheRpcScanner(config);
        await scanner.update();
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((r) => {
          entered = r;
        });
        const gate = new Promise<void>((r) => {
          release = r;
        });
        if (kind === 'update')
          vi.mocked(network.getCurrentHeight).mockImplementationOnce(
            async () => {
              entered();
              await gate;
              return 3;
            },
          );
        const busy =
          kind === 'update'
            ? scanner.update()
            : scanner.withSafety(async () => {
                entered();
                await gate;
              });
        await started;
        const action = vi.fn().mockReturnValue(42);
        try {
          await expect(scanner.withHealthRead(action, 1000, 3)).rejects.toThrow(
            'already running',
          );
          expect(action).not.toHaveBeenCalled();
        } finally {
          release();
        }
        await busy;
        await expect(scanner.withHealthRead(action, 1000, 3)).resolves.toEqual(
          42,
        );
      },
    );

    /**
     * @target AvalancheRpcScanner.withHealthRead refuses finite queue overload without invoking the extra callback
     * @dependencies SQLite state and a held health read.
     * @scenario Fill one active and one waiting slot, then request a third.
     * @expected Overload fails immediately; admitted calls recover and slots are reusable.
     */
    it('refuses finite queue overload without invoking the extra callback', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const first = scanner.withHealthRead(
        async () => {
          entered();
          await gate;
          return 1;
        },
        1000,
        2,
      );
      await started;
      const second = scanner.withHealthRead(() => 2, 1000, 2),
        extra = vi.fn();
      try {
        await expect(scanner.withHealthRead(extra, 1000, 2)).rejects.toThrow(
          'queue is full',
        );
        expect(extra).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
      await expect(scanner.withHealthRead(() => 3, 1000, 2)).resolves.toEqual(
        3,
      );
    });

    /**
     * @target AvalancheRpcScanner.withHealthRead expires a waiting callback without late invocation
     * @dependencies SQLite state and held active read.
     * @scenario Let a queued request expire before releasing its predecessor.
     * @expected Timeout rejects; the expired callback never runs and cleanup permits later reads.
     */
    it('expires a waiting callback without late invocation', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const first = scanner.withHealthRead(
        async () => {
          entered();
          await gate;
        },
        1000,
        2,
      );
      await started;
      const action = vi.fn();
      const expired = scanner.withHealthRead(action, 20, 2);
      try {
        await expect(expired).rejects.toThrow('deadline exceeded');
        expect(action).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await first;
      await new Promise((r) => setImmediate(r));
      expect(action).not.toHaveBeenCalled();
      await expect(scanner.withHealthRead(() => 42, 1000, 2)).resolves.toEqual(
        42,
      );
    });

    /**
     * @target AvalancheRpcScanner.withHealthRead retains an expired active lease until its actual %s
     * @dependencies SQLite state and a read completing after its deadline.
     * @scenario Expire an active read, attempt update, then resolve or reject the real work.
     * @expected Deadline rejects with no late result; update remains excluded until work ends and recovers.
     */
    it.each(['resolution', 'rejection'] as const)(
      'retains an expired active lease until its actual %s',
      async (kind) => {
        const scanner = new AvalancheRpcScanner(config);
        await scanner.update();
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((r) => {
          entered = r;
        });
        const gate = new Promise<void>((resolve, reject) => {
          release = () =>
            kind === 'resolution'
              ? resolve()
              : reject(new Error('late-failure'));
        });
        const read = scanner.withHealthRead(
          async () => {
            entered();
            await gate;
            return 42;
          },
          20,
          2,
        );
        await started;
        try {
          await expect(read).rejects.toThrow('deadline exceeded');
          await expect(scanner.update()).rejects.toThrow('already running');
        } finally {
          release();
        }
        await new Promise((r) => setImmediate(r));
        await scanner.update();
        await expect(
          scanner.withHealthRead(() => 43, 1000, 2),
        ).resolves.toEqual(43);
      },
    );

    /**
     * @target AvalancheRpcScanner.withHealthRead releases admission after a %s callback failure
     * @dependencies SQLite state and a failing read callback.
     * @scenario Throw synchronously or reject asynchronously, then update and read.
     * @expected The exact failure propagates; queue and scanner exclusion recover.
     */
    it.each(['synchronous', 'asynchronous'] as const)(
      'releases admission after a %s callback failure',
      async (kind) => {
        const scanner = new AvalancheRpcScanner(config);
        await scanner.update();
        const failure = new Error('read-failure');
        await expect(
          scanner.withHealthRead(
            () => {
              if (kind === 'asynchronous') return Promise.reject(failure);
              throw failure;
            },
            1000,
            2,
          ),
        ).rejects.toBe(failure);
        await scanner.update();
        await expect(
          scanner.withHealthRead(() => 42, 1000, 2),
        ).resolves.toEqual(42);
      },
    );

    /**
     * @target AvalancheRpcScanner.withHealthRead refuses unqualified state before callback invocation
     * @dependencies SQLite scanner state with a persisted hold.
     * @scenario Persist a hold before health admission.
     * @expected Qualification fails and callback is not invoked; clearing the fixture hold permits recovery.
     */
    it('refuses unqualified state before callback invocation', async () => {
      const scanner = new AvalancheRpcScanner(config);
      await scanner.update();
      const repo = database.getRepository(AvalancheSafetyState),
        state = await repo.findOneByOrFail({ scanner: 'avalanche' });
      state.holdReason = 'synthetic-hold';
      await repo.save(state);
      const action = vi.fn().mockReturnValue(42);
      await expect(scanner.withHealthRead(action, 1000, 2)).rejects.toThrow(
        'not qualified',
      );
      expect(action).not.toHaveBeenCalled();
      state.holdReason = null;
      await repo.save(state);
      await expect(scanner.withHealthRead(action, 1000, 2)).resolves.toEqual(
        42,
      );
    });

    /**
     * @target AvalancheRpcScanner.withHealthRead refuses invalid %s bounds before callback invocation
     * @dependencies SQLite scanner configuration and invalid deadline or capacity.
     * @scenario Supply a nonpositive, unsafe or overflowing bound.
     * @expected Bounds refuse without invoking callbacks or acquiring a lease.
     */
    it.each([
      ['zero deadline', 0, 2],
      ['overflow deadline', 2147483648, 2],
      ['fractional deadline', 1.5, 2],
      ['zero capacity', 1000, 0],
      ['unsafe capacity', 1000, Number.MAX_SAFE_INTEGER + 1],
    ] as const)(
      'refuses invalid %s bounds before callback invocation',
      async (_label, timeout, capacity) => {
        const scanner = new AvalancheRpcScanner(config),
          action = vi.fn();
        await expect(
          scanner.withHealthRead(action, timeout, capacity),
        ).rejects.toThrow('Invalid');
        expect(action).not.toHaveBeenCalled();
      },
    );
  });
});
