/** Synthetic unreachable loopback endpoint; replay reads are mocked in each case. */
export const connection = { url: 'http://localhost:1' };

/** Shared metadata for synthetic native assets and their Ergo counterparts. */
export const asset = {
  name: 'synthetic asset',
  type: 'test',
  residency: 'test',
  extra: {},
};

/** Synthetic bridge lock address. */
export const lockAddress = '0x' + '11'.repeat(20);
/** Canonical block hash shared by the replay transaction fixtures. */
export const blockHash = '0x' + 'aa'.repeat(32);
/** Encoded Rosen metadata with fees and an Ergo destination. */
export const rawData =
  '00000000007554fc820000000000962f582103f999da8e6e42660e4464d17d29e63bc006734a6710a24eb489b466323d3a9339';
