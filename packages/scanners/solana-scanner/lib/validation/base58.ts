import bs58 from 'bs58';

/** Validate a canonical Solana public key or transaction signature. */
export const isCanonicalBase58 = (
  value: unknown,
  byteLength: 32 | 64,
): boolean => {
  if (typeof value !== 'string') return false;

  // A 32-byte value needs at most 44 base58 characters; a 64-byte value
  // needs at most 88. Check this before decoding attacker-controlled text.
  const maxTextLength = byteLength === 32 ? 44 : 88;
  if (value.length === 0 || value.length > maxTextLength) return false;

  try {
    const decoded = bs58.decode(value);
    return decoded.length === byteLength && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
};
