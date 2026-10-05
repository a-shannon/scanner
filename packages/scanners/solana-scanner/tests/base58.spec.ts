import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';

import { isCanonicalBase58 } from '../lib/validation/base58';

describe('isCanonicalBase58', () => {
  /**
   * @target isCanonicalBase58 accepts %i-byte values for every possible first byte
   * @dependencies deterministic byte arrays and the bs58 encoder
   * @scenario encode each possible first byte in 32-byte and 64-byte values
   * @expected every canonical encoding is accepted at its exact byte length
   */
  it.each([32, 64] as const)(
    'accepts %i-byte values for every possible first byte',
    (byteLength) => {
      for (let firstByte = 0; firstByte <= 0xff; firstByte++) {
        const bytes = new Uint8Array(byteLength).fill(0xff);
        bytes[0] = firstByte;
        const encoded = bs58.encode(bytes);

        expect(isCanonicalBase58(encoded, byteLength)).toBe(true);
      }
    },
  );

  /**
   * @target isCanonicalBase58 accepts the reviewed F1 public key beginning with byte 0x01
   * @dependencies reviewed F1 public-key fixture
   * @scenario validate the 32-byte base58 representation
   * @expected the canonical public key is accepted
   */
  it('accepts the reviewed F1 public key beginning with byte 0x01', () => {
    expect(
      isCanonicalBase58('8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKg', 32),
    ).toBe(true);
  });

  /**
   * @target isCanonicalBase58 preserves multiple leading zero bytes canonically
   * @dependencies bs58 encoding and a fixed 32-byte input
   * @scenario encode a value with five leading zero bytes
   * @expected the leading base58 zero markers remain and the value validates
   */
  it('preserves multiple leading zero bytes canonically', () => {
    const bytes = new Uint8Array(32);
    bytes.set([0, 0, 0, 0, 0, 0xff], 0);
    const encoded = bs58.encode(bytes);

    expect(encoded.startsWith('11111')).toBe(true);
    expect(isCanonicalBase58(encoded, 32)).toBe(true);
  });

  /**
   * @target isCanonicalBase58 accepts exact %i-byte values including first byte 0xff
   * @dependencies deterministic byte arrays and the bs58 encoder
   * @scenario validate exact 32-byte and 64-byte encodings with first byte 0xff
   * @expected both full-width values are accepted
   */
  it.each([32, 64] as const)(
    'accepts exact %i-byte values including first byte 0xff',
    (byteLength) => {
      const bytes = new Uint8Array(byteLength).fill(0x7b);
      bytes[0] = 0xff;

      expect(isCanonicalBase58(bs58.encode(bytes), byteLength)).toBe(true);
    },
  );

  /**
   * @target isCanonicalBase58 rejects $actualLength bytes for expected $byteLength bytes
   * @dependencies deterministic arrays with lengths immediately below and above each bound
   * @scenario validate 31, 33, 63, and 65 byte encodings against their requested lengths
   * @expected every mismatched decoded length is rejected
   */
  it.each([
    { byteLength: 32 as const, actualLength: 31 },
    { byteLength: 32 as const, actualLength: 33 },
    { byteLength: 64 as const, actualLength: 63 },
    { byteLength: 64 as const, actualLength: 65 },
  ])(
    'rejects $actualLength bytes for expected $byteLength bytes',
    ({ byteLength, actualLength }) => {
      expect(
        isCanonicalBase58(
          bs58.encode(new Uint8Array(actualLength)),
          byteLength,
        ),
      ).toBe(false);
    },
  );

  /**
   * @target isCanonicalBase58 rejects invalid alphabet, non-strings, empty text, and oversized text
   * @dependencies invalid alphabet input and invalid value-type/length cases
   * @scenario validate malformed and out-of-bound base58 inputs
   * @expected each invalid input is rejected
   */
  it('rejects invalid alphabet, non-strings, empty text, and oversized text', () => {
    expect(isCanonicalBase58('0'.repeat(32), 32)).toBe(false);
    expect(isCanonicalBase58('', 32)).toBe(false);
    expect(isCanonicalBase58(123, 32)).toBe(false);
    expect(isCanonicalBase58('1'.repeat(89), 64)).toBe(false);
  });

  /**
   * @target isCanonicalBase58 checks the text bound before calling the decoder
   * @dependencies bs58 decoder spy
   * @scenario submit inputs exceeding the text bound for 32-byte and 64-byte values
   * @expected both inputs are rejected without invoking the decoder
   */
  it('checks the text bound before calling the decoder', () => {
    const decodeSpy = vi.spyOn(bs58, 'decode');

    expect(isCanonicalBase58('1'.repeat(45), 32)).toBe(false);
    expect(isCanonicalBase58('1'.repeat(89), 64)).toBe(false);
    expect(decodeSpy).not.toHaveBeenCalled();

    decodeSpy.mockRestore();
  });
});
