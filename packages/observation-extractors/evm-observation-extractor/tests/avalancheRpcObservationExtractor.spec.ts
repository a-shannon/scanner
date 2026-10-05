import { blake2b } from 'blakejs';
import { TransactionReceipt, TransactionReceiptParams } from 'ethers';

import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';

import { AvalancheRpcNetwork } from '../../../scanners/evm-scanner/lib/avalancheRpcNetwork';
import { AvalancheRpcObservationExtractor } from '../lib';
import {
  block,
  derivedBlockHash,
  derivedTokenConfig,
  erc20Address,
  erc20Target,
  lockAddress,
  nativeTarget,
  otherAddress,
  rawData,
  toAddress,
  settledBlock,
  joeTokenConfig,
  joeMainnetRequest,
} from './avalancheTestData';
import {
  createTokenMap,
  createMinedTransaction,
  createTransaction,
  erc20Data,
  initializeAddressManager,
  attachMinedIdentity,
  createTransferReceipt,
  createJoeMainnetTransaction,
  createSettledBlock,
} from './avalancheTestUtils';
import { createDatabase } from './utils.mock';

describe('AvalancheRpcObservationExtractor', () => {
  let dataSource: DataSource;

  let extractor: AvalancheRpcObservationExtractor;

  beforeEach(async () => {
    initializeAddressManager();
    dataSource = await createDatabase();
    extractor = new AvalancheRpcObservationExtractor(
      lockAddress,
      dataSource,
      await createTokenMap(),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataSource.destroy();
  });

  describe('processTransactions', () => {
    /**
     * @target AvalancheRpcObservationExtractor.processTransactions extracts
     * and stores %s through the real Rosen extractor
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Create the selected mapped lock transaction and mock its successful
     * receipt.
     * @expected
     * - The stored observation has the expected chain, token, amount and
     * request fields.
     */
    it.each([
      ['native AVAX', {}, 'avax', nativeTarget, '92850989'],
      [
        'ERC20',
        { to: erc20Address, data: erc20Data(), value: 0n },
        erc20Address,
        erc20Target,
        '3305307248',
      ],
    ])(
      'extracts and stores %s through the real Rosen extractor',
      async (_name, overrides, sourceToken, targetToken, amount) => {
        const tx = createTransaction(overrides);
        const selectedBlock =
          sourceToken === 'avax'
            ? block
            : { hash: derivedBlockHash, height: 10 };
        if (sourceToken !== 'avax') attachMinedIdentity(tx);
        const wait = vi
          .spyOn(tx, 'wait')
          .mockResolvedValue(
            sourceToken === 'avax'
              ? ({} as TransactionReceipt)
              : new TransactionReceipt(createTransferReceipt(tx), tx.provider),
          );
        expect(
          await extractor.processTransactions([tx], selectedBlock),
        ).toEqual(true);
        expect(wait).toHaveBeenCalledWith(0);
        expect(
          await dataSource.getRepository(ObservationEntity).find(),
        ).toEqual([
          expect.objectContaining({
            fromChain: 'avalanche',
            toChain: 'ergo',
            extractor: 'avalanche-rpc-extractor',
            sourceChainTokenId: sourceToken,
            targetChainTokenId: targetToken,
            amount,
            sourceTxId: tx.hash,
            requestId: Buffer.from(blake2b(tx.hash, undefined, 32)).toString(
              'hex',
            ),
            sourceBlockId: selectedBlock.hash,
            height: selectedBlock.height,
            toAddress,
            rawData,
          }),
        ]);
      },
    );

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions stores
     * nothing for %s
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Change the lock, payload or supported token using each table row.
     * @expected
     * - No receipt is awaited and no observation is stored.
     */
    it.each([
      ['wrong native lock', { to: otherAddress }],
      ['wrong ERC20 lock', { to: erc20Address, data: erc20Data(otherAddress) }],
      ['malformed data', { data: '0x00' }],
      ['unsupported token', { to: otherAddress, data: erc20Data(), value: 0n }],
    ])('stores nothing for %s', async (_name, overrides) => {
      const tx = createTransaction(overrides);
      const wait = vi.spyOn(tx, 'wait');
      expect(await extractor.processTransactions([tx], block)).toEqual(true);
      expect(wait).not.toHaveBeenCalled();
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions rejects a
     * token with no destination mapping
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Use a valid destination address with no destination token mapping.
     * @expected
     * - The token lookup occurs, with no receipt wait or stored observation.
     */
    it('rejects a token with no destination mapping', async () => {
      const tokens = await createTokenMap();
      const getID = vi.spyOn(tokens, 'getID');
      extractor = new AvalancheRpcObservationExtractor(
        lockAddress,
        dataSource,
        tokens,
      );
      // Existing Ethereum destination code and valid address, absent token mapping.
      const tx = createTransaction({
        data: '0x03' + rawData.slice(2, 34) + '14' + otherAddress.slice(2),
      });
      const wait = vi.spyOn(tx, 'wait');
      expect(await extractor.processTransactions([tx], block)).toEqual(true);
      expect(getID).toHaveBeenCalledWith(expect.any(Object), 'ethereum');
      expect(wait).not.toHaveBeenCalled();
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions inherits
     * failed-receipt rejection through ethers CALL_EXCEPTION
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Reject the receipt wait with ethers CALL_EXCEPTION.
     * @expected
     * - Processing completes without storing an observation.
     */
    it('inherits failed-receipt rejection through ethers CALL_EXCEPTION', async () => {
      const tx = createTransaction();
      vi.spyOn(tx, 'wait').mockRejectedValue({ code: 'CALL_EXCEPTION' });
      expect(await extractor.processTransactions([tx], block)).toEqual(true);
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions inherits
     * fail-closed handling for a missing receipt
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Resolve the receipt wait with null.
     * @expected
     * - Processing rejects and no observation is stored.
     */
    it('inherits fail-closed handling for a missing receipt', async () => {
      const tx = createTransaction();
      vi.spyOn(tx, 'wait').mockResolvedValue(null);
      await expect(async () => {
        await extractor.processTransactions([tx], block);
      }).rejects.toThrow('waiting resulted is null or undefined');
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions inherits
     * fail-closed handling for a missing RPC transaction hash
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Remove the signed transaction hash and return a successful receipt.
     * @expected
     * - Unsigned-transaction validation rejects without storing an
     * observation.
     */
    it('inherits fail-closed handling for a missing RPC transaction hash', async () => {
      const tx = createTransaction();
      Object.defineProperty(tx, 'hash', { value: null });
      vi.spyOn(tx, 'wait').mockResolvedValue({} as TransactionReceipt);
      await expect(async () => {
        await extractor.processTransactions([tx], block);
      }).rejects.toThrow('Transactions coming from RPC have to be signed');
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions propagates
     * receipt RPC failure without storing observations
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Reject the receipt wait with a transport error.
     * @expected
     * - The error propagates and no observation is stored.
     */
    it('propagates receipt RPC failure without storing observations', async () => {
      const tx = createTransaction();
      vi.spyOn(tx, 'wait').mockRejectedValue(
        new Error('receipt RPC unavailable'),
      );
      await expect(async () => {
        await extractor.processTransactions([tx], block);
      }).rejects.toThrow('receipt RPC unavailable');
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.processTransactions preserves
     * the raw-data storage option
     * @dependencies
     * - SQLite ObservationEntity repository and mapped synthetic token
     * fixtures.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Disable raw-data storage and process a valid mapped lock transaction.
     * @expected
     * - The stored raw-data field contains the disabled-storage marker.
     */
    it('preserves the raw-data storage option', async () => {
      extractor = new AvalancheRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap(),
        undefined,
        false,
      );
      const tx = createTransaction();
      vi.spyOn(tx, 'wait').mockResolvedValue({} as TransactionReceipt);
      await extractor.processTransactions([tx], block);
      expect(
        (await dataSource.getRepository(ObservationEntity).find())[0].rawData,
      ).toEqual('raw-data extraction is off');
    });
  });
  describe('extractObservations', () => {
    let tx: ReturnType<typeof createJoeMainnetTransaction>;
    let receipt: TransactionReceiptParams;

    beforeEach(async () => {
      tx = createJoeMainnetTransaction();
      receipt = createTransferReceipt(tx);
      extractor = new AvalancheRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap(joeTokenConfig),
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.extractObservations preserves the mainnet producer request
     * through settled RPC admission
     * @dependencies
     * - Frozen generic UI producer calldata, synthetic signature and Ergo mapping.
     * - Real AvalancheRpcNetwork and real token/extractor implementations.
     * - Mocked RPC responses; no endpoint calls, keys or broadcasts.
     * @scenario
     * - Admit a mainnet transaction with matching finalized/canonical block,
     * receipt and one standard token Transfer; extract its observation.
     * @expected
     * - All nine request fields and source block survive, with wrapped amount 10.
     */
    it('preserves the mainnet producer request through settled RPC admission', async () => {
      const network = new AvalancheRpcNetwork('https://rpc.invalid', 43114n);
      const canonical = createSettledBlock(tx);
      const rpc = {
        send: vi.fn().mockResolvedValue('0xa86a'),
        getBlock: vi.fn().mockResolvedValue(canonical),
        getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      };
      Object.defineProperty(network, 'provider', { value: rpc });
      const admitted = await network.getBlockTxs(
        settledBlock.hash,
        settledBlock.height,
      );
      const observations = await extractor.extractObservations(
        admitted,
        settledBlock,
      );
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        ...joeMainnetRequest,
        sourceBlockId: settledBlock.hash,
        fromChain: 'avalanche',
      });
      expect(rpc.send).toHaveBeenCalledWith('eth_chainId', []);
      expect(rpc.getBlock).toHaveBeenCalledWith('finalized');
    });

    /**
     * @target AvalancheRpcObservationExtractor.extractObservations rejects %s
     * @dependencies
     * - Mainnet producer fixture, real TokenMap/extractor and isolated receipt edits.
     * - Mocked TransactionResponse.wait; no network or signing operations.
     * @scenario
     * - Alter only the named receipt/Transfer field of an otherwise valid request.
     * @expected
     * - No observation is admitted, including raw differences hidden by wrapping.
     */
    it.each<[string, (params: TransactionReceiptParams) => void]>([
      ['missing Transfer', (p) => (p.logs = [])],
      [
        'duplicate Transfer',
        (p) => (p.logs = [...p.logs, { ...p.logs[0], index: 1 }]),
      ],
      [
        'duplicated log position',
        (p) => (p.logs = [...p.logs, { ...p.logs[0], address: lockAddress }]),
      ],
      ['removed Transfer', (p) => (p.logs[0].removed = true)],
      ['wrong token emitter', (p) => (p.logs[0].address = lockAddress)],
      [
        'wrong event signature',
        (p) =>
          (p.logs[0].topics = [
            '0x' + '11'.repeat(32),
            ...p.logs[0].topics.slice(1),
          ]),
      ],
      [
        'wrong sender',
        (p) =>
          (p.logs[0].topics = [
            p.logs[0].topics[0],
            '0x' + '22'.repeat(32),
            p.logs[0].topics[2],
          ]),
      ],
      [
        'wrong custody',
        (p) =>
          (p.logs[0].topics = [
            ...p.logs[0].topics.slice(0, 2),
            '0x' + '33'.repeat(32),
          ]),
      ],
      [
        'nonzero indexed padding',
        (p) =>
          (p.logs[0].topics = [
            ...p.logs[0].topics.slice(0, 2),
            '0x01' + p.logs[0].topics[2].slice(4),
          ]),
      ],
      [
        'extra indexed topic',
        (p) =>
          (p.logs[0].topics = [...p.logs[0].topics, '0x' + '00'.repeat(32)]),
      ],
      ['short amount', (p) => (p.logs[0].data = '0x01')],
      ['nonhex amount', (p) => (p.logs[0].data = '0x' + 'zz'.repeat(32))],
      [
        'raw amount differing below wrap precision',
        (p) =>
          (p.logs[0].data =
            '0x' + 100000000001n.toString(16).padStart(64, '0')),
      ],
      [
        'wrong log transaction',
        (p) => (p.logs[0].transactionHash = '0x' + '11'.repeat(32)),
      ],
      [
        'wrong log block hash',
        (p) => (p.logs[0].blockHash = '0x' + '11'.repeat(32)),
      ],
      ['wrong log block height', (p) => (p.logs[0].blockNumber = 11)],
      ['wrong log transaction index', (p) => (p.logs[0].transactionIndex = 1)],
      ['negative log index', (p) => (p.logs[0].index = -1)],
      ['fractional log index', (p) => (p.logs[0].index = 0.5)],
      ['failed receipt', (p) => (p.status = 0)],
      ['unknown receipt status', (p) => (p.status = 2)],
      ['wrong receipt transaction', (p) => (p.hash = '0x' + '11'.repeat(32))],
      [
        'wrong receipt block hash',
        (p) => (p.blockHash = '0x' + '11'.repeat(32)),
      ],
      ['wrong receipt height', (p) => (p.blockNumber = 11)],
      ['wrong receipt index', (p) => (p.index = 1)],
      ['wrong receipt sender', (p) => (p.from = lockAddress)],
      ['wrong receipt contract', (p) => (p.to = lockAddress)],
    ])('rejects %s', async (_name, mutate) => {
      mutate(receipt);
      vi.spyOn(tx, 'wait').mockResolvedValue(
        new TransactionReceipt(receipt, tx.provider),
      );
      expect(await extractor.extractObservations([tx], settledBlock)).toEqual(
        [],
      );
    });

    /**
     * @target AvalancheRpcObservationExtractor.extractObservations refuses %s mapping
     * @dependencies
     * - Real TokenMap and generic Rosen extractor; synthetic mainnet lock fixture.
     * @scenario
     * - Remove the source, duplicate its mapping or remove its destination mapping.
     * @expected
     * - No observation or receipt request is produced.
     */
    it.each(['unsupported', 'ambiguous', 'missing counterpart'])(
      'refuses %s mapping',
      async (kind) => {
        const config = structuredClone(joeTokenConfig);
        if (kind === 'unsupported') config[0].avalanche.tokenId = lockAddress;
        if (kind === 'ambiguous') {
          const duplicate = structuredClone(config[0]);
          duplicate.ergo.tokenId = '77'.repeat(32);
          config.push(duplicate);
        }
        if (kind === 'missing counterpart') delete config[0].ergo;
        extractor = new AvalancheRpcObservationExtractor(
          lockAddress,
          dataSource,
          await createTokenMap(config),
        );
        const wait = vi.spyOn(tx, 'wait');
        expect(await extractor.extractObservations([tx], settledBlock)).toEqual(
          [],
        );
        expect(wait).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheRpcObservationExtractor.extractObservations propagates missing receipt
     * @dependencies
     * - Real mapped extractor and mocked receipt wait.
     * @scenario
     * - Return null for an included mainnet request's receipt.
     * @expected
     * - Extraction fails closed with no positive observation result.
     */
    it('propagates missing receipt', async () => {
      vi.spyOn(tx, 'wait').mockResolvedValue(null);
      await expect(async () => {
        await extractor.extractObservations([tx], settledBlock);
      }).rejects.toThrow('waiting resulted is null');
    });

    /**
     * @target AvalancheRpcObservationExtractor.extractObservations detaches signed fields before await
     * @dependencies
     * - Real extractor and a receipt wait that mutates its provider transaction.
     * @scenario
     * - Mutate calldata while returning the original canonical receipt.
     * @expected
     * - The original request amount and transaction identity remain bound.
     */
    it('detaches signed fields before await', async () => {
      vi.spyOn(tx, 'wait').mockImplementation(async () => {
        Object.defineProperty(tx, 'data', { value: '0x00' });
        return new TransactionReceipt(receipt, tx.provider);
      });
      const observations = await extractor.extractObservations(
        [tx],
        settledBlock,
      );
      expect(observations).toHaveLength(1);
      expect(observations[0].amount).toEqual('10');
      expect(observations[0].sourceTxId).toEqual(receipt.hash);
    });

    /**
     * @target AvalancheRpcObservationExtractor.extractObservations derives
     * observations without persisting them
     * @dependencies
     * - SQLite ObservationEntity repository and the original single native
     * AVAX token mapping with its Ergo counterpart.
     * - Real Rosen extractor and spies on TransactionResponse.wait.
     * @scenario
     * - Attach the original hex-aa block hash and height10 mined metadata to
     * the successful synthetic transaction.
     * - Derive its mapped observation without persisting it.
     * @expected
     * - One observation is returned without any database row being written.
     */
    it('derives observations without persisting them', async () => {
      const extractor = new AvalancheRpcObservationExtractor(
        lockAddress,
        dataSource,
        await createTokenMap(derivedTokenConfig),
      );
      const tx = createMinedTransaction();
      vi.spyOn(tx, 'wait').mockResolvedValue({} as TransactionReceipt);
      const derived = await extractor.extractObservations([tx], {
        height: 10,
        hash: derivedBlockHash,
      });
      expect(derived).toHaveLength(1);
      expect(derived[0]).toMatchObject({
        fromChain: 'avalanche',
        rawData,
        sourceTxId: tx.hash,
      });
      expect(await dataSource.getRepository(ObservationEntity).count()).toEqual(
        0,
      );
    });
  });
});
