# Architecture

## Foundation decisions

- **Runtime:** Bun with TypeScript in strict mode.
- **HTTP framework:** NestJS. The application is split into domain, application, infrastructure and interface layers as later stages are implemented.
- **Persistence:** PostgreSQL with MikroORM. ORM entities will remain separate from domain objects and migrations will be reversible.
- **Concurrency:** database-enforced invariants plus pessimistic row locks (`FOR UPDATE`) inside a SQL transaction. Application memory is never used for correctness.
- **Messaging:** SQS-compatible queues through MiniStack in development. MiniStack was chosen because it is a free, open-source AWS emulator with FIFO and DLQ support, while keeping the application on the standard AWS SDK contract. The event flow will use a transactional outbox and an inbox for redelivery safety.
- **Authentication:** a no-op guard is intentionally used because authentication is out of scope. The boundary is explicit in `src/auth/noop-auth.guard.ts` so a real OIDC provider can be added later without changing the domain.

## Local infrastructure

Docker Compose starts PostgreSQL and MiniStack. MiniStack creates the FIFO event queue and its FIFO DLQ from `infra/localstack/init-queues.sh`; the legacy directory name is retained because MiniStack supports the compatible init-script path.

## Domain state transitions

`WagerTransaction` starts in `PENDING`. A transaction may move to `PENDING_REFERENCE` when a required external reference is not available. From either non-terminal state it may become `PROCESSED`, `REJECTED` or `FAILED`. Those three states are terminal and any later transition is a programming error.

`InboxMessage` moves once from received to processed. `OutboxMessage` remains pending while `publishedAt` is absent; failed publication increments attempts and schedules exponential backoff. After broker confirmation it becomes published and cannot be retried.

`Wallet` owns the materialized balance and increments its version only after a successful debit or credit. `WalletLedgerEntry` is immutable and records the before/after values needed to reconstruct the balance.

## Money representation

`Money` uses `decimal.js` internally and accepts only non-negative decimal strings with at most two fractional places at input boundaries. It never stores monetary values as JavaScript `number`; serialized events use `{ amount: string, currency: string }`.

## Persistence boundary

MikroORM entities under `src/infrastructure/database/entities` represent database rows only. They do not contain business behavior. Mappers under `src/infrastructure/database/mappers` convert numeric columns to `Money` and reconstruct domain aggregates through their `rehydrate` factories.

Repositories receive the transaction-scoped `EntityManager` and expose domain objects. Reads that participate in a state change use `PESSIMISTIC_WRITE`; outbox batch reads use the partial pessimistic lock so concurrent workers can claim disjoint rows. `UnitOfWork` wraps the callback in `EntityManager.transactional`, and an explicit `flush` is available when scalar foreign-key entities must be inserted in dependency order.

## Failure codes

The initial stable business codes are `INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL`, `CURRENCY_MISMATCH`, `REFERENCE_NOT_FOUND`, `INVALID_REFERENCE_KIND`, `ALREADY_REVERSED`, `INVALID_PAYLOAD` and `WALLET_NOT_FOUND`.

## Transaction application service

`ProcessWagerTransactionUseCase` is the shared application boundary for HTTP and SQS. It creates the persistent transaction before applying the effect, locks the wallet with `PESSIMISTIC_WRITE`, writes the ledger and outbox in the same SQL transaction, and returns a typed `Result` for business outcomes. A unique-key race is resolved by reopening the transaction and replaying the row that won the insert. The current stage covers `BET`, `WIN` and `LOSS`; reference resolution for `REFUND` and `ROLLBACK` is intentionally completed in the next stage.

## Reference resolution

`REFUND` and `ROLLBACK` are initially stored as `PENDING_REFERENCE`. `PendingReferenceWorker` claims due rows using the partial pessimistic lock (`FOR UPDATE SKIP LOCKED`), locks the referenced transaction, and applies the reversal and outbox events in the same SQL transaction. Missing or still-pending references use persisted attempts and exponential backoff. Eight attempts or one hour of age produces `REJECTED` with `REFERENCE_NOT_FOUND`. A processed reference is required; `REFUND` accepts a `BET`, while `ROLLBACK` inverts a processed balance effect and maps insufficient balance to `INSUFFICIENT_FUNDS_FOR_REVERSAL`.

## Transactional outbox publisher

`OutboxPublisher` claims due rows with `FOR UPDATE SKIP LOCKED` through the existing outbox repository, publishes each event through `SqsEventPublisher`, and marks `published_at` only after the broker confirms the send. A broker failure increments the persisted attempt counter, stores a bounded error message and schedules exponential backoff in the same SQL transaction.

The lock is held while the batch is published and updated, so concurrent publisher instances claim disjoint rows. The delivery guarantee is at-least-once: a process crash after SQS accepts a message but before the database commit can cause a duplicate publication. FIFO `MessageDeduplicationId` uses the event id for broker-side deduplication during its deduplication window; consumers must still be idempotent through the inbox and event id.

The publisher starts with the NestJS application unless `OUTBOX_PUBLISHER_ENABLED=false`. Batch size and interval are configurable through `OUTBOX_PUBLISHER_BATCH_SIZE` and `OUTBOX_PUBLISHER_INTERVAL_MS`.

## SQS transaction consumer

The transaction consumer reads only `SQS_QUEUE_NAME` (`wager-transactions.fifo`). Outbox integration events are sent to the separate `SQS_EVENTS_QUEUE_NAME` (`wager-events.fifo`) so the application does not consume its own published events as provider commands.

For each received message, the consumer validates the command, inserts or locks the `(consumer_name, message_id)` inbox row, executes `ProcessWagerTransactionUseCase.executeInContext` and marks the inbox processed in the same PostgreSQL transaction. Only after that transaction commits does it issue `DeleteMessage` to SQS. A database rollback leaves the message visible for redelivery; a delete failure is also safe because a later delivery sees the processed inbox row and only acknowledges the message.

Business outcomes such as insufficient funds are committed as processed input messages, because they are valid commands with a deterministic rejection. Invalid JSON, invalid command shape, idempotency conflicts and infrastructure failures are not deleted; SQS redelivers them and the queue redrive policy moves poison messages to the FIFO DLQ after `maxReceiveCount`. The consumer uses long polling, configurable visibility timeout and a graceful stop that aborts the current receive, stops new receives and waits for the active message transaction to finish.

The consumer starts with the NestJS application unless `SQS_CONSUMER_ENABLED=false`. `SQS_CONSUMER_NAME`, `SQS_CONSUMER_WAIT_SECONDS`, `SQS_CONSUMER_VISIBILITY_TIMEOUT` and `SQS_CONSUMER_BATCH_SIZE` control its identity and polling behavior.

## Observability

`JsonLogger` emits one JSON object per application event with timestamp, level, event name and safe identifiers such as `correlationId`, `messageId`, `transactionId` and `walletId`. Financial payloads and complete message bodies are deliberately excluded.

`MetricsRegistry` exposes counters, gauges and latency summaries in Prometheus text format at `GET /metrics`. The current metrics include transaction status, duplicate/replay count, retry count by component, SQS failures and DLQ candidates, database lock conflicts, outbox lag and operation latency. Labels are normalized and escaped before rendering.

## Multi-process validation

`test/integration/multi-process.integration.test.ts` starts three real NestJS processes with `Bun.spawn`, sharing PostgreSQL and MiniStack. Concurrent bets validate that pessimistic locking plus retry of transient PostgreSQL deadlocks produces one accepted debit and one deterministic insufficient-funds rejection per wallet. The test also validates the materialized balance through reconciliation and checks that the ledger contains only one debit.

The crash-recovery scenario pauses a real SQS consumer after committing the database transaction but before `DeleteMessage`, terminates it, waits for visibility timeout and starts another process. The inbox unique key makes redelivery harmless: the second process acknowledges the message without applying the credit again. This models the at-least-once window between broker acknowledgment and database commit/observation.

`SQS_CONSUMER_PAUSE_BEFORE_DELETE_MS` is a test-only failure-injection hook and must remain disabled in production.

## Known limitations at this stage

The required multi-process concurrency and crash-before-ack scenarios are covered. The remaining work is documentation and optional load testing; authentication remains intentionally out of scope. The delivery model remains at-least-once, so consumers outside this service must also be idempotent.

## HTTP boundary

`WalletController` exposes wallet creation, lookup, cursor-paginated ledger and reconciliation. A positive initial wallet balance creates an internal processed `OPENING` transaction and immutable credit entry, so reconciliation can reconstruct the materialized balance from the ledger. `WageringController` requires the `Idempotency-Key` header, hashes the canonical JSON body with SHA-256, delegates to the shared use case and maps `PROCESSED` to 201/200, `PENDING_REFERENCE` to 202, rejected business outcomes to 422, payload conflicts to 409, validation to 400 and persistence unavailability to 503.

Ledger cursors are base64url-encoded JSON containing only the last entry id. The cursor is opaque at the API boundary and is decoded/validated before reaching the repository. The no-op authentication guard remains active because authentication is outside the challenge scope.
