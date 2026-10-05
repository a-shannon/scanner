# Solana scanner

This package scans finalized Solana blocks and stores its cursor and extracted
deposit candidates in SQLite. `createSolanaScanner` composes the scanner from
a `SolanaRpc`, a block projector, a stable scanner/extractor identity, and a
database path. It returns the `SolanaFinalizedScanner` and its store; call
`scanner.update()` to advance a bounded batch of finalized slots.

The scanner binds its state to a cluster genesis hash, configured anchor,
projector policy, and scanner identity. It checks retained history and block
continuity before committing each batch. A `SolanaHistorySource` can be
provided to supply transaction-indexed account history to the projector. The
exported `HttpSolanaRpc` adapter reads finalized JSON-RPC blocks; callers may
provide a fetch implementation for controlled transport.

The scanner records observations produced by the supplied projector. It does
not authenticate its RPC source. The integrating service must set the asset
allowlist and endpoint policy before enabling bridge flows. Use a trusted
history source when past account state matters.
