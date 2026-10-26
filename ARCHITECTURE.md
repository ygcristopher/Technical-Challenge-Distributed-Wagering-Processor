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

## State transitions

The transaction state machine and failure taxonomy will be expanded with the domain and use-case stages. The initial application only exposes liveness/readiness placeholders.

## Known limitations at this stage

No financial behavior, persistence schema, SQS consumer, outbox publisher, or authentication has been implemented yet. Those are deliberately introduced in the subsequent stages with integration tests against real PostgreSQL and SQS-compatible infrastructure.
