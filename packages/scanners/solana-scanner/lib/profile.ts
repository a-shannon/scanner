import { createHash } from 'node:crypto';

import { SolanaScanRef } from './types';

export interface SolanaAssetBinding {
  assetId: string;
  programId: string;
  mint: string | null;
  vaultTokenAccount: string | null;
  sourceDecimals: number;
  destinationDecimals: number;
  destinationTokenId: string;
  minAmount: string;
  maxAmount: string;
  networkFee: string;
  bridgeFee: string;
}

/** Validated inputs actually consumed by the Solana L2 projector. */
export interface SolanaProjectorProfile {
  genesisHash: string;
  destinationChain: 'ergo';
  destinationNetwork: string;
  vaultOwner: string;
  assets: readonly SolanaAssetBinding[];
  memoVersion: 1;
  projectorVersion: string;
}

export interface SolanaScanIdentity {
  scannerId: string;
  extractorId: string;
  anchor: SolanaScanRef;
}

export interface SolanaScanProfile
  extends SolanaProjectorProfile,
    SolanaScanIdentity {}

/** Check that a value is nonempty text within the requested length limit. */
const validText = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

/** Check that a value is a safe, nonnegative integer no greater than the limit. */
const validUint = (
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;

/** Check for canonical unsigned decimal text within the uint64 range. */
const validAmount = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= (1n << 64n) - 1n;

/** Policies are source units; RosenData already carries exact final units. */
export const expectedSolanaFee = (
  sourceAmount: string,
  sourceDecimals: number,
  destinationDecimals: number,
): string => {
  if (
    !validAmount(sourceAmount) ||
    !validUint(sourceDecimals, 18) ||
    !validUint(destinationDecimals, 18)
  )
    throw new Error('INVALID_SOLANA_FEE');
  const raw = BigInt(sourceAmount);
  const divisor =
    10n ** BigInt(Math.max(0, sourceDecimals - destinationDecimals));
  if (raw % divisor !== 0n) throw new Error('SOLANA_FEE_DUST');
  const scaled =
    (raw / divisor) *
    10n ** BigInt(Math.max(0, destinationDecimals - sourceDecimals));
  if (scaled > (1n << 63n) - 1n) throw new Error('SOLANA_FEE_OVERFLOW');
  return scaled.toString();
};

/** Validate the scan identity, anchor, projector fields, and every asset binding. */
export const validateSolanaScanProfile = (profile: SolanaScanProfile): void => {
  if (
    !profile ||
    !validText(profile.genesisHash, 128) ||
    profile.destinationChain !== 'ergo' ||
    !['mainnet', 'testnet'].includes(profile.destinationNetwork) ||
    !validText(profile.scannerId, 128) ||
    !validText(profile.extractorId, 128) ||
    !validText(profile.vaultOwner, 128) ||
    profile.memoVersion !== 1 ||
    !validText(profile.projectorVersion, 128) ||
    !profile.anchor ||
    !validUint(profile.anchor.slot) ||
    !validUint(profile.anchor.blockHeight, 2_147_483_647) ||
    !validText(profile.anchor.blockhash, 128) ||
    !Array.isArray(profile.assets) ||
    profile.assets.length === 0
  )
    throw new Error('INVALID_SOLANA_SCAN_PROFILE');

  const assetIds = new Set<string>();
  for (const asset of profile.assets) {
    if (
      !asset ||
      !validText(asset.assetId, 128) ||
      !validText(asset.programId, 128) ||
      (asset.mint !== null && !validText(asset.mint, 128)) ||
      (asset.vaultTokenAccount !== null &&
        !validText(asset.vaultTokenAccount, 128)) ||
      (asset.mint === null) !== (asset.vaultTokenAccount === null) ||
      !validUint(asset.sourceDecimals, 18) ||
      !validUint(asset.destinationDecimals, 18) ||
      !/^[0-9a-f]{64}$/.test(asset.destinationTokenId) ||
      !validAmount(asset.minAmount) ||
      !validAmount(asset.maxAmount) ||
      !validAmount(asset.networkFee) ||
      !validAmount(asset.bridgeFee) ||
      BigInt(asset.minAmount) > BigInt(asset.maxAmount) ||
      assetIds.has(asset.assetId)
    )
      throw new Error('INVALID_SOLANA_ASSET_BINDING');
    expectedSolanaFee(
      asset.networkFee,
      asset.sourceDecimals,
      asset.destinationDecimals,
    );
    expectedSolanaFee(
      asset.bridgeFee,
      asset.sourceDecimals,
      asset.destinationDecimals,
    );
    assetIds.add(asset.assetId);
  }
};

/** Derive the durable policy from the descriptor of the actual projector. */
export const createSolanaScanProfile = (
  projector: SolanaProjectorProfile,
  identity: SolanaScanIdentity,
): SolanaScanProfile => {
  const profile: SolanaScanProfile = {
    genesisHash: projector.genesisHash,
    destinationChain: projector.destinationChain,
    destinationNetwork: projector.destinationNetwork,
    vaultOwner: projector.vaultOwner,
    assets: structuredClone(projector.assets),
    memoVersion: projector.memoVersion,
    projectorVersion: projector.projectorVersion,
    scannerId: identity.scannerId,
    extractorId: identity.extractorId,
    anchor: { ...identity.anchor },
  };
  validateSolanaScanProfile(profile);
  return profile;
};

/** Fixed-order, versioned serialization; the caller cannot supply its digest. */
export const serializeSolanaScanProfile = (
  profile: SolanaScanProfile,
): string => {
  validateSolanaScanProfile(profile);
  const assets = [...profile.assets]
    .sort((left, right) =>
      left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0,
    )
    .map((asset) => [
      asset.assetId,
      asset.programId,
      asset.mint,
      asset.vaultTokenAccount,
      asset.sourceDecimals,
      asset.destinationDecimals,
      asset.destinationTokenId,
      asset.minAmount,
      asset.maxAmount,
      asset.networkFee,
      asset.bridgeFee,
    ]);
  return JSON.stringify([
    'rosen-solana-profile-v2',
    profile.genesisHash,
    profile.destinationChain,
    profile.destinationNetwork,
    profile.scannerId,
    profile.extractorId,
    profile.anchor.slot,
    profile.anchor.blockHeight,
    profile.anchor.blockhash,
    profile.vaultOwner,
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    profile.memoVersion,
    profile.projectorVersion,
    assets,
  ]);
};

/** Return the SHA-256 binding of the validated, fixed-order profile serialization. */
export const bindSolanaScanProfile = (profile: SolanaScanProfile): string =>
  createHash('sha256')
    .update(serializeSolanaScanProfile(profile), 'utf8')
    .digest('hex');
