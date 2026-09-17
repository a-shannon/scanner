# Monero observation extractor

Durable deposit capture for the Rosen scanner 2.0.3 and observation entity 1.0.10.
This package joins asynchronous deposit evidence to the existing scanner and
observation database. The production Monero verifier and watcher/guard composition
are separate integration requirements; this package alone does not authorize credit.

## Capture and admission

`processTransactions` durably captures candidates before returning success to the
scanner. Missing proofs therefore do not stop later blocks. The caller periodically
runs `processPending(limit)` to obtain fresh verification results and atomically
insert accepted `ObservationEntity` rows at their original source block and height.

Register `MoneroCandidateEntity` alongside the existing scanner and observation
entities. Apply `migrations.sqlite` before starting the scanner. SQLite is the only
supported database. Supply **two initialized connections to the same disk database**:
one for the scanner, one exclusively for candidate admission. Sharing a connection
would allow upstream scanner transactions to interleave with admission transactions.

```ts
const extractor = new MoneroObservationExtractor(
  scannerDataSource,
  admissionDataSource,
  candidatePolicy,
  decodeCandidate,
  verifyDeposit,
  { verificationTimeoutMs: 15_000, maxConcurrentVerifications: 4 },
);
await scanner.registerExtractor(extractor);
await scanner.update();
const outcomes = await extractor.processPending(4);
```

The composition must provide these functions:

- `decodeCandidate(transaction, block)` recognizes supported deposit metadata and
  returns the exact transaction ID and bytes. Malformed recognized deposits must
  remain diagnosable; an unknown decoding failure must not become silent success.
- `verifyDeposit(candidate, signal)` reconstructs current authority and returns
  `pending`, independently verified policy `expired`, or `accepted` with the exact
  Rosen observation. It must honor cancellation and impose its own evidence limits.
  An exception or missing/invalid delivery is retryable, not permanent rejection.

The verifier must check native transaction identity, selected output and amount,
vault ownership, payment-proof/destination binding, committee-authorized key image,
fresh canonical inclusion, unspent state, confirmations and policy. Permanent
output/key-image credit uniqueness belongs to the backing ledger and guard path.
Serialized candidate rows or a caller-supplied `accepted` value do not supply those
properties. `scope` is a configured digest of network, vault and verification policy;
it must change when any of those authorities changes.

The current Rosen request ID is the BLAKE2b-256 digest of the transaction-ID string.
The configured deposit profile must select one supported event per transaction.
Its Monero output descriptor belongs in the observation; it must not be interpreted
as a refund address or replaced with a transaction-level balance.

## Recovery and resource bounds

Candidate capture is immutable and idempotent. A process may exit after capture
commits but before the scanner cursor advances; replay reuses the retained input.
Admission uses a leased attempt and a short `BEGIN IMMEDIATE` transaction. It
checks the current lease and exact source block's `PROCEED` status, inserts the
observation and completes the candidate together. Conflicting existing observations
are rejected, never overwritten. Fork handling invalidates leases and removes only
observations anchored to the old block.

`maxCandidates` includes accepted, expired and orphaned records. Reaching the
configured retention limit stops capture before advancing the scanner; no record
is silently discarded. Operators need monitored storage and a reviewed archival
policy. `maxTransactionBytes`, retry delay, lease duration, batch size and verifier
concurrency are explicit bounds. An abort-ignoring verifier retains its concurrency
slot until it settles; repeated timeouts cannot multiply background work.

Call `close()` on the extractor and connector before stopping their scheduling.
They cancel active reads/verifications and reject new work. Finish pending batches
before closing database connections. A provider ignoring cancellation may require
its owning process to be terminated.

The watcher still applies its `observationValidThreshold` to the **original** source
height. Proofs arriving after that window need an explicit expiry/recovery policy;
changing an observation's height would misrepresent its confirmation/reorg anchor.
Expiry does not refund or erase the underlying deposit.

## Daemon connector

`MoneroNetworkConnector` reads ordinary transactions from two to eight configured
HTTP(S) daemon origins. Every endpoint must agree on genesis, block and transaction
bytes. It checks the source block again after fetching transactions, allowing normal
tip growth but rejecting source replacement. Response size, cumulative block bytes,
transaction count, batch size and full-response time are bounded. Exceeding a bound
stops processing; it never truncates a block. All-peer agreement favors safety over
availability when a configured node fails or disagrees.

RPC agreement does not verify binary hashes or establish independently administered
nodes. Native validation and deployment topology remain required. The connector
contains no wallet RPC, signing or broadcast methods.

## Validation

Run `npm run build` and `npm test` in this package. Tests use actual Rosen scanner
and observation entities with disk SQLite, and mocked daemon responses. Coverage
includes delayed evidence, fresh-process crash recovery, conflicts, leases,
rollback during verification, cancellation and resource bounds. They do not claim
live-chain operation or production deployment qualification.
