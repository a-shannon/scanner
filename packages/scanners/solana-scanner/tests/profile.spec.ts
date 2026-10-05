import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  bindSolanaScanProfile,
  expectedSolanaFee,
  serializeSolanaScanProfile,
  SolanaScanProfile,
} from '../lib/profile';

/** Returns the deterministic profile shared by identity and fee cases. */
const profile = (): SolanaScanProfile => ({
  genesisHash: '1'.repeat(32),
  destinationChain: 'ergo',
  destinationNetwork: 'mainnet',
  scannerId: 'scanner',
  extractorId: 'extractor',
  vaultOwner: 'vault',
  memoVersion: 1,
  projectorVersion: 'fixture',
  anchor: { slot: 1, blockHeight: 1, blockhash: '1'.repeat(32) },
  assets: ['a', 'Z'].map((assetId) => ({
    assetId,
    programId: 'program',
    mint: null,
    vaultTokenAccount: null,
    sourceDecimals: 9,
    destinationDecimals: 9,
    destinationTokenId: 'a'.repeat(64),
    minAmount: '1',
    maxAmount: '1000',
    networkFee: '1',
    bridgeFee: '1',
  })),
});

describe('profile identity v2', () => {
  /**
   * @target bindSolanaScanProfile sorts assets ordinally independent of input order
   * @dependencies profile fixtures with the same assets in opposite orders
   * @scenario bind both profiles and inspect serialized asset order
   * @expected both bindings match and serialization uses ordinal asset order
   */
  it('sorts assets ordinally independent of input order', () => {
    const first = profile();
    const second = { ...first, assets: [...first.assets].reverse() };
    expect(bindSolanaScanProfile(first)).toBe(bindSolanaScanProfile(second));
    const fields = JSON.parse(serializeSolanaScanProfile(first));
    expect(fields.at(-1).map((asset: string[]) => asset[0])).toEqual([
      'Z',
      'a',
    ]);
  });
  /**
   * @target bindSolanaScanProfile does not reuse the v1 identity without a destination chain
   * @dependencies current serialized profile and a v1-shaped field sequence
   * @scenario hash the legacy identity fields and compare with the current binding
   * @expected the current profile binding differs from the v1 identity
   */
  it('does not reuse the v1 identity without a destination chain', () => {
    const current = profile();
    const oldFields = JSON.parse(serializeSolanaScanProfile(current));
    oldFields[0] = 'rosen-solana-profile-v1';
    oldFields.splice(2, 1);
    const oldBinding = createHash('sha256')
      .update(JSON.stringify(oldFields))
      .digest('hex');
    expect(oldBinding).not.toBe(bindSolanaScanProfile(current));
  });
});

describe('source-policy fee expectations', () => {
  /**
   * @target expectedSolanaFee maps %s from %s to %s decimals exactly
   * @dependencies fee values covering decimal scaling and wide integer boundaries
   * @scenario convert each listed source fee between its source and destination precision
   * @expected each fee is returned as its exact decimal integer string
   */
  it.each([
    ['1000', 6, 3, '1'],
    ['2000', 6, 3, '2'],
    ['1000', 9, 9, '1000'],
    ['12', 3, 6, '12000'],
    ['0', 18, 0, '0'],
    ['9223372036854775807', 0, 0, '9223372036854775807'],
  ])('maps %s from %s to %s decimals exactly', (value, from, to, expected) => {
    expect(expectedSolanaFee(value, from, to)).toBe(expected);
  });
  /**
   * @target expectedSolanaFee refuses inexact or out-of-range fee %s
   * @dependencies fee inputs covering dust, signed overflow, u64 overflow, noncanonical text, and invalid precision
   * @scenario evaluate each listed fee against source-policy conversion bounds
   * @expected each input throws its specified validation code
   */
  it.each([
    ['1001', 6, 3, 'SOLANA_FEE_DUST'],
    ['9223372036854775808', 0, 0, 'SOLANA_FEE_OVERFLOW'],
    ['18446744073709551616', 0, 0, 'INVALID_SOLANA_FEE'],
    ['01', 0, 0, 'INVALID_SOLANA_FEE'],
    ['1', 19, 0, 'INVALID_SOLANA_FEE'],
  ])('refuses inexact or out-of-range fee %s', (value, from, to, code) => {
    expect(() => expectedSolanaFee(value, from, to)).toThrow(code);
  });
});
