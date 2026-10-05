import { describe, expect, it } from 'vitest';

import { prepareSolanaHistory } from '../lib/scanner/prepareHistory';
import { SolanaBlockHistory, SolanaHistorySource } from '../lib/types';

const request = {
  genesisHash: 'genesis',
  slot: 103,
  blockHeight: 51,
  blockhash: 'block',
  signatures: ['signature', 'second'],
};
const payload = {
  clusterGenesisHash: 'genesis',
  slot: 103,
  sourceTxId: 'signature',
  amount: '18446744073709551615',
};
/** Builds the fixed history response used by preparation cases. */
const response = (): SolanaBlockHistory => ({
  genesisHash: 'genesis',
  slot: 103,
  blockhash: 'block',
  entries: [
    { signature: 'signature', serializedHistory: JSON.stringify(payload) },
  ],
});
/** Wraps a fixed response in the history-source interface. */
const source = (value: SolanaBlockHistory): SolanaHistorySource => ({
  getBlockHistory: async () => value,
});

describe('bounded history preparation', () => {
  /**
   * @target prepareSolanaHistory keeps exact amounts and passes immutable request coordinates to the source
   * @dependencies fixed request, history payload, and source callback
   * @scenario prepare a response while checking the frozen request and configured limits
   * @expected the exact integer payload is retained and byte usage is reported
   */
  it('keeps exact amounts and passes immutable request coordinates to the source', async () => {
    const result = await prepareSolanaHistory(
      {
        getBlockHistory: async (seen, limits) => {
          expect(Object.isFrozen(seen)).toBe(true);
          expect(Object.isFrozen(seen.signatures)).toBe(true);
          expect(limits).toEqual({ maxEntries: 2, maxBytes: 4096 });
          return response();
        },
      },
      request,
      4096,
    );
    expect(result.history.get('signature')).toEqual(payload);
    expect(result.bytes).toBeGreaterThan(0);
  });

  /**
   * @target prepareSolanaHistory rejects isolated %s corruption
   * @dependencies one-field history-envelope, entry, binding, or JSON mutations
   * @scenario independently corrupt each listed response property or serialized field
   * @expected preparation rejects with the corresponding fault code
   */
  it.each([
    [
      'genesis',
      (r: SolanaBlockHistory) => {
        r.genesisHash = 'other';
      },
      'HISTORY_ENVELOPE',
    ],
    [
      'slot',
      (r: SolanaBlockHistory) => {
        r.slot = 104;
      },
      'HISTORY_ENVELOPE',
    ],
    [
      'blockhash',
      (r: SolanaBlockHistory) => {
        r.blockhash = 'other';
      },
      'HISTORY_ENVELOPE',
    ],
    [
      'unknown signature',
      (r: SolanaBlockHistory) => {
        r.entries[0].signature = 'other';
      },
      'HISTORY_ENTRY',
    ],
    [
      'duplicate signature',
      (r: SolanaBlockHistory) => {
        r.entries = [r.entries[0], r.entries[0]];
      },
      'HISTORY_ENTRY',
    ],
    [
      'too many entries',
      (r: SolanaBlockHistory) => {
        r.entries = Array(3).fill(r.entries[0]);
      },
      'HISTORY_ENVELOPE',
    ],
    [
      'internal genesis',
      (r: SolanaBlockHistory) => {
        r.entries[0].serializedHistory = JSON.stringify({
          ...payload,
          clusterGenesisHash: 'other',
        });
      },
      'HISTORY_BINDING',
    ],
    [
      'internal slot',
      (r: SolanaBlockHistory) => {
        r.entries[0].serializedHistory = JSON.stringify({
          ...payload,
          slot: 104,
        });
      },
      'HISTORY_BINDING',
    ],
    [
      'internal signature',
      (r: SolanaBlockHistory) => {
        r.entries[0].serializedHistory = JSON.stringify({
          ...payload,
          sourceTxId: 'second',
        });
      },
      'HISTORY_BINDING',
    ],
    [
      'duplicate JSON key',
      (r: SolanaBlockHistory) => {
        r.entries[0].serializedHistory = '{"slot":103,"slot":103}';
      },
      'HISTORY_JSON',
    ],
    [
      'unsafe number',
      (r: SolanaBlockHistory) => {
        r.entries[0].serializedHistory = '{"slot":9007199254740993}';
      },
      'HISTORY_JSON',
    ],
    [
      'exponent',
      (r: SolanaBlockHistory) => {
        r.entries[0].serializedHistory = '{"slot":1e2}';
      },
      'HISTORY_JSON',
    ],
  ])('rejects isolated %s corruption', async (_label, mutate, code) => {
    const value = response();
    mutate(value);
    await expect(
      prepareSolanaHistory(source(value), request, 4096),
    ).rejects.toMatchObject({ code });
  });

  /**
   * @target prepareSolanaHistory accepts the exact payload byte limit and rejects limit minus one
   * @dependencies serialized history bytes and signature length
   * @scenario prepare at the exact measured byte limit and one byte below it
   * @expected the exact bound succeeds and the smaller bound fails with HISTORY_BYTES_BOUND
   */
  it('accepts the exact payload byte limit and rejects limit minus one', async () => {
    const value = response();
    const bytes =
      Buffer.byteLength(value.entries[0].serializedHistory) +
      Buffer.byteLength('signature');
    await expect(
      prepareSolanaHistory(source(value), request, bytes),
    ).resolves.toMatchObject({ bytes });
    await expect(
      prepareSolanaHistory(source(value), request, bytes - 1),
    ).rejects.toMatchObject({ code: 'HISTORY_BYTES_BOUND' });
  });

  /**
   * @target prepareSolanaHistory leaves absent history explicit for the concrete extractor to decide
   * @dependencies undefined history source and a valid request
   * @scenario prepare history without a configured source
   * @expected the returned history map is empty
   */
  it('leaves absent history explicit for the concrete extractor to decide', async () => {
    expect(
      (await prepareSolanaHistory(undefined, request, 4096)).history.size,
    ).toBe(0);
  });
});
