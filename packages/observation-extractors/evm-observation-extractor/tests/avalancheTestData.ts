import { RosenTokens } from '@rosen-bridge/tokens';

/** Synthetic block identity attached to the extracted observation fixtures. */
export const block = { hash: 'avalanche-block', height: 10 };

/** Original mined block identity for the no-persistence derivation fixture. */
export const derivedBlockHash = '0x' + 'aa'.repeat(32);

/** Canonical synthetic settled block used by the mainnet producer replay. */
export const settledBlock = {
  hash: derivedBlockHash,
  height: 10,
  parentHash: '0x' + 'bb'.repeat(32),
  timestamp: 100,
};

/** Public mainnet JOE contract identity; no deployment or custody is implied. */
export const joeAddress = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
/** Synthetic Ergo counterpart used only for the local JOE fixture. */
export const joeCounterpart = '66'.repeat(32);
/** Frozen generic UI mainnet producer bytes with synthetic lock custody. */
export const joeCallData =
  '0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111' +
  '000000000000000000000000000000000000000000000000000000174876e800' +
  '00000000000000000200000000000000032103f999da8e6e42660e4464d17d29e63bc006734a6710a24eb489b466323d3a9339';

/** Synthetic bridge lock address shared by the native and ERC20 cases. */
export const lockAddress = '0x' + '11'.repeat(20);
/** Synthetic ERC20 contract address used to exercise inherited EVM extraction. */
export const erc20Address = '0x' + '22'.repeat(20);
/** Synthetic address outside the configured lock and token mapping. */
export const otherAddress = '0x' + '33'.repeat(20);
/** Synthetic Ergo counterpart token ID for the native AVAX fixture. */
export const nativeTarget = '44'.repeat(32);
/** Synthetic Ergo counterpart token ID for the ERC20 fixture. */
export const erc20Target = '55'.repeat(32);
/** Encoded Rosen metadata with fees and a valid Ergo destination. */
export const rawData =
  '00000000007554fc820000000000962f582103f999da8e6e42660e4464d17d29e63bc006734a6710a24eb489b466323d3a9339';
/** Ergo destination encoded in the synthetic Rosen metadata. */
export const toAddress = '9iMjQx8PzwBKXRvsFUJFJAPoy31znfEeBUGz8DRkcnJX4rJYjVd';

/** JOE's public source identity paired with a synthetic eight-decimal counterpart. */
export const joeTokenConfig: RosenTokens = [
  {
    avalanche: {
      tokenId: joeAddress,
      name: 'JOE',
      decimals: 18,
      type: 'ERC-20',
      residency: 'native',
      extra: {},
    },
    ergo: {
      tokenId: joeCounterpart,
      name: 'synthetic counterpart',
      decimals: 8,
      type: 'test',
      residency: 'test',
      extra: {},
    },
  },
];

/** All nine request fields independently derived from the frozen mainnet producer. */
export const joeMainnetRequest = {
  toChain: 'ergo',
  toAddress,
  bridgeFee: '2',
  networkFee: '3',
  fromAddress: '0x8c5c59c57b660b323ec5e9b48fdb95a99fde84ce',
  sourceChainTokenId: joeAddress,
  amount: '10',
  targetChainTokenId: joeCounterpart,
  sourceTxId:
    '0x43bde42f26f289ce7eb35f116adcb32c4efd967f1e46ef64d1b660e26d5f7513',
};

/** Synthetic AVAX and ERC20 mappings with their Ergo counterparts. */
export const tokenConfig: RosenTokens = [
  {
    avalanche: {
      tokenId: 'avax',
      name: 'synthetic test asset',
      decimals: 18,
      type: 'test',
      residency: 'test',
      extra: {},
    },
    ergo: {
      tokenId: nativeTarget,
      name: 'synthetic test asset',
      decimals: 9,
      type: 'test',
      residency: 'test',
      extra: {},
    },
  },
  {
    avalanche: {
      tokenId: erc20Address,
      name: 'synthetic test asset',
      decimals: 6,
      type: 'test',
      residency: 'test',
      extra: {},
    },
    ergo: {
      tokenId: erc20Target,
      name: 'synthetic test asset',
      decimals: 6,
      type: 'test',
      residency: 'test',
      extra: {},
    },
  },
];

/** Original native-only AVAX mapping used by the moved derivation case. */
export const derivedTokenConfig: RosenTokens = [
  {
    avalanche: {
      tokenId: 'avax',
      name: 'synthetic asset',
      decimals: 18,
      type: 'test',
      residency: 'test',
      extra: {},
    },
    ergo: {
      tokenId: nativeTarget,
      name: 'synthetic asset',
      decimals: 9,
      type: 'test',
      residency: 'test',
      extra: {},
    },
  },
];
