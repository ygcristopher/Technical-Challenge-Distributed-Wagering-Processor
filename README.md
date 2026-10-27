# Distributed Wagering Processor

Servico financeiro distribuido para processar eventos de apostas (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) por HTTP e SQS, com PostgreSQL como fonte de verdade.

O projeto foi construido para permanecer correto com mensagens duplicadas, fora de ordem e processadas em paralelo por varias instancias. A aplicacao usa Bun, TypeScript strict, NestJS, MikroORM, PostgreSQL e MiniStack.

## Pre-requisitos

- Bun >= 1.1
- Docker Desktop com Docker Compose
- Portas locais 3000, 5432 e 4566 disponiveis

## Inicio rapido

PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up -d
bun install
bun run build
bun run migration:up
bun test
bun run dev
```

Linux/macOS:

```sh
cp .env.example .env
docker compose up -d
bun install
bun run build
bun run migration:up
bun test
bun run dev
```

A API fica em `http://localhost:3000`. O script de inicializacao do MiniStack cria:

- `wager-transactions.fifo`: comandos de provedores;
- `wager-events.fifo`: eventos publicados pela outbox;
- `wager-transactions-dlq.fifo`: mensagens de comando que excederam o redrive policy.

## Comandos

| Comando | Finalidade |
|---|---|
| `bun run dev` | Executa a API com watch |
| `bun run build` | Compila TypeScript strict para `dist/` |
| `bun run lint` | Executa ESLint |
| `bun test` | Executa testes unitarios e de integracao |
| `bun run test:integration` | Compila, aplica migration e executa testes de integracao |
| `bun run migration:up` | Aplica migrations pendentes |
| `bun run migration:down` | Reverte a ultima migration |
| `docker compose down` | Para os containers preservando volumes |
| `docker compose down -v` | Para containers e remove dados locais |

Os testes de integracao exigem PostgreSQL e MiniStack ativos. Eles nao mockam esses servicos.

## API HTTP

### Health e metricas

- `GET /health/live`: processo vivo; responde `200`.
- `GET /health/ready`: verifica PostgreSQL e SQS; responde `200` ou `503`.
- `GET /metrics`: metricas em formato Prometheus.

### Wallets

- `POST /wallets`: cria uma wallet. Campos: `playerId`, `currency` e `initialBalance` opcional.
- `GET /wallets?playerId=...&currency=BRL`: consulta por jogador e moeda.
- `GET /wallets/:walletId`: consulta por id.
- `GET /wallets/:walletId/ledger?limit=50&cursor=...`: ledger imutavel paginado.
- `GET /wallets/:walletId/reconciliation`: compara saldo materializado com saldo reconstruido do ledger.

Exemplo de criacao:

```json
{
  "playerId": "player-1",
  "currency": "BRL",
  "initialBalance": "100.00"
}
```

### Wagering

`POST /wagering/transactions` exige `Idempotency-Key`. O corpo contem `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `amount`, `currency` e, para `REFUND`/`ROLLBACK`, `referenceExternalTransactionId`.

Exemplo:

```http
POST /wagering/transactions
Idempotency-Key: provider-1-bet-1
Content-Type: application/json
```

```json
{
  "providerId": "provider-1",
  "externalTransactionId": "bet-1",
  "walletId": "<wallet-id>",
  "playerId": "player-1",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "amount": "80.00",
  "currency": "BRL"
}
```

Status relevantes:

- `201`: transacao nova processada;
- `200`: replay idempotente;
- `202`: referencia ainda pendente;
- `400`: contrato ou payload invalido;
- `409`: mesma chave de idempotencia com payload diferente;
- `422`: rejeicao deterministica de negocio, como `INSUFFICIENT_FUNDS`;
- `503`: indisponibilidade de persistencia.

## Garantias de consistencia

- dinheiro trafega como string decimal com duas casas; nenhum `number` representa valor financeiro;
- PostgreSQL impoe saldo nao negativo, unicidade de wallet, idempotencia e ledger imutavel;
- cada efeito financeiro grava wallet, ledger, transacao e outbox na mesma transacao SQL;
- locks pessimistas e retry de conflitos protegem concorrencia entre processos;
- Inbox impede efeito duplicado em redelivery SQS;
- Outbox publica somente depois do commit e trabalha com entrega at-least-once;
- `REFUND` e `ROLLBACK` usam `PENDING_REFERENCE` com backoff persistido;
- reconciliacao permite verificar `wallet.balance == soma reconstruida pelo ledger`.

## Configuracao

A configuracao local esta em [.env.example](./.env.example). Os principais controles sao:

- `DATABASE_URL`, `AWS_ENDPOINT` e credenciais locais;
- `SQS_CONSUMER_ENABLED`, `SQS_CONSUMER_NAME`, batch, visibility timeout e long polling;
- `OUTBOX_PUBLISHER_ENABLED`, intervalo e tamanho do lote;
- `SQS_QUEUE_NAME`, `SQS_EVENTS_QUEUE_NAME` e `SQS_DLQ_NAME`.

`SQS_CONSUMER_PAUSE_BEFORE_DELETE_MS` e um hook exclusivo dos testes de crash recovery; nao deve ser habilitado em producao.

## Documentacao complementar

- [ARCHITECTURE.md](./ARCHITECTURE.md): decisoes, trade-offs, limites e algoritmos;
- [ESTUDO.md](./ESTUDO.md): explicacao didatica etapa por etapa;
- [infra/ministack/init-queues.sh](./infra/ministack/init-queues.sh): criacao das filas FIFO e DLQ;
- [test/integration/multi-process.integration.test.ts](./test/integration/multi-process.integration.test.ts): concorrencia multi-processo e crash antes do ACK.

Autenticacao esta fora do escopo do desafio e usa um guard no-op documentado na arquitetura.
