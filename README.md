# Distributed Wagering Processor

Serviço financeiro distribuído para processar eventos de apostas (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) via HTTP e SQS.

O ambiente local usa MiniStack como emulador AWS, com uma fila FIFO de comandos (`wager-transactions.fifo`), uma fila FIFO de eventos (`wager-events.fifo`) e uma DLQ. A aplicação continuará usando o contrato/SDK padrão da AWS, permitindo trocar o endpoint local por SQS real sem alterar o domínio.

## Requisitos locais

- Bun `>= 1.1`
- Docker Desktop com Docker Compose

## Começar

```sh
cp .env.example .env
docker compose up -d
bun install
bun test
bun run dev
```

Endpoints provisórios da fundação:

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

`/health/ready` verifica PostgreSQL e SQS; retorna `200` quando ambos estão acessíveis e `503` caso contrário.

Para parar a infraestrutura:

```sh
docker compose down
```

Use `docker compose down -v` apenas para remover também os volumes locais do Postgres e do LocalStack.

## Evolução por etapas

O plano e os critérios de pronto estão descritos em `ARCHITECTURE.md` e o material de estudo detalhado está em `ESTUDO.md`. Ambos serão atualizados junto com cada etapa. A implementação financeira começa pelo schema e migrations, mantendo as garantias críticas no banco.
