import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  MoneroBlockPacket,
  MoneroIndexedTransaction,
} from './moneroNetworkConnector';

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_NATIVE_INPUT_BYTES = 16 * 1024 * 1024 + 128 * 1024;
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES = 65_536;
const MAX_CONFIGURED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_U64 = 18_446_744_073_709_551_615n;

type JsonRecord = Record<string, unknown>;

export interface NativeDepositCommitteeMember {
  id: number;
  publicKey: string;
}

export interface NativeDepositCommittee {
  genesis: string;
  epoch: string;
  ceremony: string;
  threshold: 2;
  profile: 'ed25519-shamir-untweaked-standard';
  roster: {
    groupKey: string;
    verificationShares: NativeDepositCommitteeMember[];
  };
  identities: NativeDepositCommitteeMember[];
  sourcePolicy: null | 'authenticated-backing-v1';
}

export interface NativeDepositObserverOptions {
  nativeBinary: string;
  nativeBinarySha256: string;
  committee: NativeDepositCommittee;
  viewKey: string;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export interface NativeDepositObservation {
  version: 1;
  committeeDigest: string;
  sourceBinding: string;
  genesis: string;
  vaultAddress: string;
  txId: string;
  blockHash: string;
  blockHeight: number;
  outputIndex: number;
  globalIndex: number;
  outputKey: string;
  commitment: string;
  amountAtomic: string;
  keyImage: string;
  depositData: readonly string[];
}

const failConfiguration = (): never => {
  throw Error('Invalid native deposit observer configuration');
};
const failRequest = (): never => {
  throw Error('Invalid native deposit request');
};
const failResult = (): never => {
  throw Error('Invalid native deposit result');
};

const record = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error();
  return value as JsonRecord;
};

const exactKeys = (value: JsonRecord, expected: readonly string[]) => {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !(key in value))
  )
    throw Error();
};

const safeInteger = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_INTEGER
  )
    throw Error();
  return value;
};

const fixedHex = (value: unknown, bytes: number): string => {
  if (
    typeof value !== 'string' ||
    value.length !== bytes * 2 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw Error();
  return value;
};

const variableHex = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw Error();
  return value;
};

const canonicalDecimal = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > MAX_U64
  )
    throw Error();
  return value;
};

const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    safeInteger(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = record(value);
  const keys = Object.keys(object).sort();
  if (keys.some((key) => !/^[\x20-\x7e]*$/.test(key))) throw Error();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
};

const parseCanonicalFrame = (frame: string, maximum: number): JsonRecord => {
  if (
    frame.length === 0 ||
    Buffer.byteLength(frame) > maximum ||
    [...frame].some((character) => character.charCodeAt(0) > 0x7f) ||
    !frame.endsWith('\n')
  )
    throw Error();
  const raw = frame.slice(0, -1);
  const value = record(JSON.parse(raw));
  if (canonicalJson(value) !== raw) throw Error();
  return value;
};

const domainDigest = (domain: string, value: unknown): string =>
  createHash('sha256')
    .update(domain)
    .update(Buffer.from([0]))
    .update(canonicalJson(value))
    .digest('hex');

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const cloneCommittee = (value: unknown): NativeDepositCommittee => {
  const committee = record(value);
  exactKeys(committee, [
    'genesis',
    'epoch',
    'ceremony',
    'threshold',
    'profile',
    'roster',
    'identities',
    'sourcePolicy',
  ]);
  const genesis = fixedHex(committee.genesis, 32);
  const epoch = fixedHex(committee.epoch, 32);
  const ceremony = fixedHex(committee.ceremony, 32);
  if ([genesis, epoch, ceremony].some((item) => /^0+$/.test(item)))
    throw Error();
  if (
    committee.threshold !== 2 ||
    committee.profile !== 'ed25519-shamir-untweaked-standard' ||
    ![null, 'authenticated-backing-v1'].includes(
      committee.sourcePolicy as null | string,
    )
  )
    throw Error();
  const roster = record(committee.roster);
  exactKeys(roster, ['groupKey', 'verificationShares']);
  const groupKey = fixedHex(roster.groupKey, 32);
  if (/^0+$/.test(groupKey)) throw Error();

  const members = (
    rows: unknown,
    bytes: number,
    compressed: boolean,
  ): NativeDepositCommitteeMember[] => {
    if (!Array.isArray(rows) || rows.length !== 4) throw Error();
    const result = rows.map((value, slot) => {
      const row = record(value);
      exactKeys(row, ['id', 'publicKey']);
      const id = safeInteger(row.id);
      const publicKey = fixedHex(row.publicKey, bytes);
      if (id !== slot + 1 || /^0+$/.test(publicKey)) throw Error();
      if (compressed && !/^(?:02|03)/.test(publicKey)) throw Error();
      return { id, publicKey };
    });
    if (
      compressed &&
      new Set(result.map((row) => row.publicKey)).size !== result.length
    )
      throw Error();
    return result;
  };
  const verificationShares = members(roster.verificationShares, 32, false);
  const identities = members(committee.identities, 33, true);
  return deepFreeze({
    genesis,
    epoch,
    ceremony,
    threshold: 2,
    profile: 'ed25519-shamir-untweaked-standard',
    roster: { groupKey, verificationShares },
    identities,
    sourcePolicy:
      committee.sourcePolicy as NativeDepositCommittee['sourcePolicy'],
  });
};

const cloneTransaction = (value: unknown): MoneroIndexedTransaction => {
  const transaction = record(value);
  exactKeys(transaction, ['txId', 'transactionHex', 'outputIndices']);
  const txId = fixedHex(transaction.txId, 32);
  const transactionHex = variableHex(transaction.transactionHex);
  if (!Array.isArray(transaction.outputIndices)) throw Error();
  const outputIndices = transaction.outputIndices.map(safeInteger);
  if (new Set(outputIndices).size !== outputIndices.length) throw Error();
  return { txId, transactionHex, outputIndices };
};

const clonePacket = (value: unknown): MoneroBlockPacket => {
  const packet = record(value);
  exactKeys(packet, [
    'blockHex',
    'blockHash',
    'height',
    'miner',
    'transactions',
  ]);
  if (!Array.isArray(packet.transactions)) throw Error();
  const result = {
    blockHex: variableHex(packet.blockHex),
    blockHash: fixedHex(packet.blockHash, 32),
    height: safeInteger(packet.height),
    miner: cloneTransaction(packet.miner),
    transactions: packet.transactions.map(cloneTransaction),
  };
  const ids = [
    result.miner.txId,
    ...result.transactions.map((row) => row.txId),
  ];
  if (new Set(ids).size !== ids.length) throw Error();
  if (Buffer.byteLength(canonicalJson(result)) > MAX_PACKET_BYTES)
    throw Error();
  return deepFreeze(result);
};

const binaryDigest = async (path: string): Promise<string> => {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error();
  return await new Promise<string>((resolve, reject) => {
    const digest = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => digest.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(digest.digest('hex')));
  });
};

type ProcessFailure = 'abort' | 'timeout' | 'output' | 'process';

export class NativeDepositObserver {
  readonly committee: NativeDepositCommittee;
  private readonly nativeBinary: string;
  private readonly nativeBinarySha256: string;
  private readonly viewKey: string;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;

  constructor(options: NativeDepositObserverOptions) {
    try {
      const value = record(options);
      exactKeys(value, [
        'nativeBinary',
        'nativeBinarySha256',
        'committee',
        'viewKey',
        'timeoutMs',
        'maxInputBytes',
        'maxOutputBytes',
      ]);
      if (
        typeof options.nativeBinary !== 'string' ||
        !isAbsolute(options.nativeBinary) ||
        options.nativeBinary.includes('\0')
      )
        throw Error();
      this.nativeBinary = options.nativeBinary;
      this.nativeBinarySha256 = fixedHex(options.nativeBinarySha256, 32);
      this.viewKey = fixedHex(options.viewKey, 32);
      if (/^0+$/.test(this.viewKey)) throw Error();
      this.timeoutMs = safeInteger(options.timeoutMs);
      this.maxInputBytes = safeInteger(options.maxInputBytes);
      this.maxOutputBytes = safeInteger(options.maxOutputBytes);
      if (
        this.timeoutMs < 1 ||
        this.timeoutMs > MAX_TIMEOUT_MS ||
        this.maxInputBytes < 1 ||
        this.maxInputBytes > MAX_NATIVE_INPUT_BYTES ||
        this.maxOutputBytes < 1 ||
        this.maxOutputBytes > MAX_CONFIGURED_OUTPUT_BYTES
      )
        throw Error();
      this.committee = cloneCommittee(options.committee);
    } catch {
      failConfiguration();
    }
  }

  observe = async (
    packet: MoneroBlockPacket,
    certificate: string,
    txId: string,
    outputIndex: number,
    signal: AbortSignal,
  ): Promise<NativeDepositObservation> => {
    if (signal.aborted) throw Error('Native deposit observation aborted');

    let input: Buffer;
    let selectedGlobalIndex: number;
    let expectedSourceBinding: string;
    let requestPacket: MoneroBlockPacket;
    try {
      requestPacket = clonePacket(packet);
      txId = fixedHex(txId, 32);
      outputIndex = safeInteger(outputIndex);
      const selected = requestPacket.transactions.filter(
        (row) => row.txId === txId,
      );
      if (
        selected.length !== 1 ||
        outputIndex >= selected[0].outputIndices.length
      )
        throw Error();
      selectedGlobalIndex = selected[0].outputIndices[outputIndex];
      if (typeof certificate !== 'string') throw Error();
      const certificateValue = parseCanonicalFrame(
        certificate,
        MAX_CERTIFICATE_BYTES,
      );
      const config = record(certificateValue.config);
      if (config.type !== 'inspect-source') throw Error();
      const shared = { ...config };
      delete shared.type;
      expectedSourceBinding = domainDigest(
        'rosen-monero/local-source-config/v1',
        shared,
      );
      const wire = `${canonicalJson({
        version: 1,
        committee: this.committee,
        viewKey: this.viewKey,
        packet: requestPacket,
        certificate,
        txId,
        outputIndex,
      })}\n`;
      input = Buffer.from(wire, 'utf8');
      if (input.byteLength > this.maxInputBytes) throw Error();
    } catch {
      return failRequest();
    }

    let before: string;
    try {
      before = await binaryDigest(this.nativeBinary);
    } catch {
      input.fill(0);
      throw Error('Native deposit binary integrity failure');
    }
    if (before !== this.nativeBinarySha256) {
      input.fill(0);
      throw Error('Native deposit binary integrity failure');
    }
    if (signal.aborted) {
      input.fill(0);
      throw Error('Native deposit observation aborted');
    }

    let child;
    try {
      child = spawn(this.nativeBinary, ['verify-deposit'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      input.fill(0);
      throw Error('Native deposit verifier failed');
    }

    const execution = await new Promise<{
      stdout: Buffer;
      failure?: ProcessFailure;
      code: number | null;
      processSignal: string | null;
      stderrBytes: number;
    }>((resolve) => {
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: ProcessFailure | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: ProcessFailure) => {
        failure ??= reason;
        try {
          child.kill('SIGKILL');
        } catch {
          // The close event still owns process-slot cleanup.
        }
      };
      const onAbort = () => stop('abort');
      const account = (length: number) => {
        if (stdoutBytes + stderrBytes + length > this.maxOutputBytes) {
          stop('output');
          return false;
        }
        return true;
      };
      child.stdout.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!account(bytes.byteLength)) return;
        stdoutBytes += bytes.byteLength;
        chunks.push(Buffer.from(bytes));
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!account(bytes.byteLength)) return;
        stderrBytes += bytes.byteLength;
      });
      child.once('error', () => stop('process'));
      child.stdin.once('error', () => stop('process'));
      child.once('close', (code, processSignal) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({
          stdout: Buffer.concat(chunks, stdoutBytes),
          failure,
          code,
          processSignal,
          stderrBytes,
        });
      });
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => stop('timeout'), this.timeoutMs);
      if (signal.aborted) onAbort();
      try {
        child.stdin.end(input);
      } catch {
        stop('process');
      }
    });
    input.fill(0);

    let after: string;
    try {
      after = await binaryDigest(this.nativeBinary);
    } catch {
      throw Error('Native deposit binary integrity failure');
    }
    if (after !== this.nativeBinarySha256)
      throw Error('Native deposit binary integrity failure');
    if (execution.failure === 'abort')
      throw Error('Native deposit observation aborted');
    if (execution.failure === 'timeout')
      throw Error('Native deposit observation timed out');
    if (execution.failure === 'output')
      throw Error('Native deposit output limit exceeded');
    if (
      execution.failure ||
      execution.code !== 0 ||
      execution.processSignal !== null ||
      execution.stderrBytes !== 0
    )
      throw Error('Native deposit verifier failed');

    try {
      const stdout = new TextDecoder('utf-8', { fatal: true }).decode(
        execution.stdout,
      );
      const value = parseCanonicalFrame(stdout, this.maxOutputBytes);
      exactKeys(value, [
        'version',
        'committeeDigest',
        'sourceBinding',
        'genesis',
        'vaultAddress',
        'txId',
        'blockHash',
        'blockHeight',
        'outputIndex',
        'globalIndex',
        'outputKey',
        'commitment',
        'amountAtomic',
        'keyImage',
        'depositData',
      ]);
      const committeeDigest = fixedHex(value.committeeDigest, 32);
      const sourceBinding = fixedHex(value.sourceBinding, 32);
      const genesis = fixedHex(value.genesis, 32);
      const resultTxId = fixedHex(value.txId, 32);
      const blockHash = fixedHex(value.blockHash, 32);
      const blockHeight = safeInteger(value.blockHeight);
      const resultOutputIndex = safeInteger(value.outputIndex);
      const globalIndex = safeInteger(value.globalIndex);
      if (
        value.version !== 1 ||
        committeeDigest !==
          domainDigest(
            'rosen-monero/source-certificate-committee/v1',
            this.committee,
          ) ||
        sourceBinding !== expectedSourceBinding ||
        genesis !== this.committee.genesis ||
        resultTxId !== txId ||
        blockHash !== requestPacket.blockHash ||
        blockHeight !== requestPacket.height ||
        resultOutputIndex !== outputIndex ||
        globalIndex !== selectedGlobalIndex ||
        typeof value.vaultAddress !== 'string' ||
        !/^4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/.test(
          value.vaultAddress,
        ) ||
        !Array.isArray(value.depositData)
      )
        throw Error();
      const depositData = value.depositData.map(variableHex);
      return deepFreeze({
        version: 1,
        committeeDigest,
        sourceBinding,
        genesis,
        vaultAddress: value.vaultAddress,
        txId: resultTxId,
        blockHash,
        blockHeight,
        outputIndex: resultOutputIndex,
        globalIndex,
        outputKey: fixedHex(value.outputKey, 32),
        commitment: fixedHex(value.commitment, 32),
        amountAtomic: canonicalDecimal(value.amountAtomic),
        keyImage: fixedHex(value.keyImage, 32),
        depositData,
      });
    } catch {
      return failResult();
    }
  };
}
