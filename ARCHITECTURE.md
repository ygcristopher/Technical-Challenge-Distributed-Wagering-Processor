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

## Known limitations at this stage

HTTP financial endpoints, SQS consumer and outbox publisher have not been implemented yet. Persistence and the core transaction use case now have integration coverage against real PostgreSQL. Authentication remains intentionally out of scope.
