# Arquitetura

## Decisões fundamentais

- **Runtime:** Bun com TypeScript em modo strict.
- **Framework HTTP:** NestJS. A aplicação é dividida em domínio, aplicação, infraestrutura e interfaces.
- **Persistência:** PostgreSQL com MikroORM. As entidades do ORM permanecem separadas dos objetos de domínio e as migrations são reversíveis.
- **Concorrência:** invariantes garantidas pelo banco e locks pessimistas (`FOR UPDATE`) dentro de uma transação SQL. A memória do processo nunca é usada como garantia de correção.
- **Mensageria:** filas compatíveis com SQS através do MiniStack no desenvolvimento. A escolha mantém o contrato do SDK AWS e permite trocar o endpoint local por SQS real. O fluxo usa Outbox transacional e Inbox para segurança contra redelivery.
- **Autenticação:** um guard no-op é usado intencionalmente porque autenticação está fora do escopo. O ponto de extensão está explícito em `src/auth/noop-auth.guard.ts`, permitindo adicionar OIDC futuramente sem alterar o domínio.

## Infraestrutura local

O Docker Compose inicia PostgreSQL e MiniStack. O MiniStack cria a fila FIFO de comandos, a fila FIFO de eventos e a DLQ FIFO através de `infra/ministack/init-queues.sh`.

## Transições de estado do domínio

`WagerTransaction` começa em `PENDING`. Pode passar para `PENDING_REFERENCE` quando uma referência externa necessária ainda não está disponível. A partir de um estado não terminal, pode chegar a `PROCESSED`, `REJECTED` ou `FAILED`. Esses três estados são terminais; qualquer transição posterior é erro de programação.

`InboxMessage` passa uma única vez de recebido para processado. `OutboxMessage` permanece pendente enquanto `publishedAt` não existe; uma publicação falha incrementa as tentativas e agenda backoff exponencial. Depois da confirmação do broker, torna-se publicada e não deve ser tentada novamente.

`Wallet` possui o saldo materializado e incrementa sua versão somente depois de um débito ou crédito bem-sucedido. `WalletLedgerEntry` é imutável e registra os valores antes/depois necessários para reconstruir o saldo.

## Representação de dinheiro

`Money` usa `decimal.js` internamente e aceita somente strings decimais não negativas com no máximo duas casas decimais nas bordas de entrada. Nunca armazena valores monetários como `number` do JavaScript. Eventos serializados usam `{ amount: string, currency: string }`.

## Limite de persistência

As entidades MikroORM em `src/infrastructure/database/entities` representam apenas linhas do banco e não contêm comportamento de negócio. Os mappers em `src/infrastructure/database/mappers` convertem colunas numéricas para `Money` e reconstroem agregados através das factories `rehydrate`.

Os repositórios recebem o `EntityManager` da transação e expõem objetos de domínio. Leituras que participam de uma alteração usam `PESSIMISTIC_WRITE`; leituras em lote da outbox usam lock parcial para que workers concorrentes assumam lotes diferentes. A `UnitOfWork` envolve o callback em `EntityManager.transactional`, e o `flush` explícito permite inserir entidades com dependências na ordem correta.

## Taxonomia de falhas

Os códigos de negócio são estáveis e persistidos na transação:

- `INSUFFICIENT_FUNDS`: BET sem saldo suficiente;
- `INSUFFICIENT_FUNDS_FOR_REVERSAL`: rollback que não pode ser coberto pelo saldo atual;
- `CURRENCY_MISMATCH`: moedas incompatíveis;
- `REFERENCE_NOT_FOUND`: referência ausente depois do limite de tentativas;
- `INVALID_REFERENCE_KIND`: referência incompatível com o tipo de reversão;
- `ALREADY_REVERSED`: segunda reversão aceita para a mesma referência;
- `INVALID_PAYLOAD`: dados inválidos;
- `WALLET_NOT_FOUND`: wallet inexistente.

Esses resultados são rejeições determinísticas e, na API HTTP, normalmente correspondem a `422`.

## Hash de idempotência

Na borda HTTP, o sistema calcula um digest SHA-256 do corpo da requisição e armazena o resultado junto de `(provider_id, idempotency_key)`. Uma repetição com a mesma chave e o mesmo hash é replay; o sistema devolve a transação original com `idempotentReplay=true`. A mesma chave com hash diferente é conflito de idempotência e corresponde a `409`.

Mensagens SQS usam o hash SHA-256 do corpo recebido. O `messageId` do SQS identifica a mensagem no Inbox, enquanto o hash identifica o conteúdo utilizado pela transação.

## Serviço de aplicação de transações

`ProcessWagerTransactionUseCase` é o limite compartilhado entre HTTP e SQS. Ele cria a transação persistente, bloqueia a wallet com `PESSIMISTIC_WRITE`, aplica a regra de negócio, grava o ledger e a outbox na mesma transação SQL e retorna um `Result` tipado para resultados de negócio.

Uma corrida de inserção por chave única é resolvida reabrindo a transação e lendo a linha que venceu a disputa. Deadlocks ou conflitos transitórios de lock (`40P01`/`55P03`) também causam retry limitado em uma nova transação.

As operações `BET`, `WIN` e `LOSS` são aplicadas diretamente. `REFUND` e `ROLLBACK` são inicialmente armazenadas como `PENDING_REFERENCE` e resolvidas pelo worker de referências.

## Resolução de referências

`PendingReferenceWorker` busca transações vencidas usando lock parcial com `FOR UPDATE SKIP LOCKED`, bloqueia a referência e aplica a reversão e seus eventos na mesma transação SQL.

Referências inexistentes ou ainda pendentes usam tentativas persistidas e backoff exponencial. Oito tentativas ou uma hora de idade produzem `REJECTED` com `REFERENCE_NOT_FOUND`. A referência precisa estar processada; `REFUND` aceita uma `BET`, enquanto `ROLLBACK` inverte um efeito financeiro processado e pode produzir `INSUFFICIENT_FUNDS_FOR_REVERSAL`.

## Publisher transacional da Outbox

`OutboxPublisher` busca lotes vencidos com `FOR UPDATE SKIP LOCKED`, publica cada evento através de `SqsEventPublisher` e marca `published_at` somente depois da confirmação do broker. Uma falha do broker incrementa as tentativas persistidas, registra um erro limitado e agenda backoff.

O lock permanece ativo durante a publicação e atualização do lote, portanto publishers concorrentes assumem linhas diferentes. A garantia externa é at-least-once: uma queda depois de o SQS aceitar a mensagem e antes do commit pode causar publicação duplicada. A deduplicação FIFO usa o `eventId` como `MessageDeduplicationId` durante a janela do broker, mas consumidores ainda precisam usar Inbox/idempotência.

O publisher inicia com a aplicação NestJS, exceto quando `OUTBOX_PUBLISHER_ENABLED=false`. O tamanho do lote e o intervalo são controlados por `OUTBOX_PUBLISHER_BATCH_SIZE` e `OUTBOX_PUBLISHER_INTERVAL_MS`.

## Consumer de transações SQS

O consumer lê apenas `SQS_QUEUE_NAME` (`wager-transactions.fifo`). Eventos de integração são enviados para `SQS_EVENTS_QUEUE_NAME` (`wager-events.fifo`), evitando que a aplicação consuma seus próprios eventos como comandos de provedores.

Para cada mensagem, o consumer valida o comando, insere ou bloqueia a linha `(consumer_name, message_id)` do Inbox, executa `ProcessWagerTransactionUseCase.executeInContext` e marca o Inbox como processado na mesma transação PostgreSQL. Somente depois do commit chama `DeleteMessage`.

Uma falha antes do commit deixa a mensagem disponível para redelivery. Uma falha no delete também é segura: uma entrega posterior encontra o Inbox processado e apenas confirma a mensagem sem repetir o efeito.

Resultados de negócio, como saldo insuficiente, são commits válidos e a mensagem é confirmada. JSON inválido, comando inválido, conflito de idempotência e falhas de infraestrutura permanecem disponíveis para retry; a política de redrive envia mensagens venenosas para a DLQ após `maxReceiveCount`.

O consumer usa long polling, visibility timeout configurável e shutdown gracioso: interrompe novos receives, aborta o receive atual e aguarda o processamento ativo terminar antes de fechar os recursos.

O consumer inicia com a aplicação, exceto quando `SQS_CONSUMER_ENABLED=false`. `SQS_CONSUMER_NAME`, `SQS_CONSUMER_WAIT_SECONDS`, `SQS_CONSUMER_VISIBILITY_TIMEOUT` e `SQS_CONSUMER_BATCH_SIZE` controlam seu comportamento.

## Observabilidade

`JsonLogger` emite um objeto JSON por evento da aplicação, contendo timestamp, nível, nome do evento e identificadores seguros como `correlationId`, `messageId`, `transactionId` e `walletId`. Payloads financeiros completos não são registrados.

`MetricsRegistry` expõe counters, gauges e resumos de latência em formato Prometheus através de `GET /metrics`. As métricas incluem status das transações, duplicatas/replays, retries por componente, falhas e candidatos a DLQ do SQS, conflitos de lock, lag da outbox e latência das operações.

## Validação multi-processo

`test/integration/multi-process.integration.test.ts` inicia três processos NestJS reais usando `Bun.spawn`, compartilhando PostgreSQL e MiniStack. A concorrência de apostas valida que locks pessimistas e retry de deadlocks transitórios produzem um débito aceito e uma rejeição determinística por saldo insuficiente para cada wallet.

O cenário de recuperação pausa um consumer real depois do commit e antes do `DeleteMessage`, encerra o processo, aguarda o visibility timeout e inicia outro processo. A chave única do Inbox torna o redelivery seguro: a segunda instância confirma a mensagem sem aplicar o crédito novamente.

`SQS_CONSUMER_PAUSE_BEFORE_DELETE_MS` é um hook de injeção de falha exclusivo dos testes e deve permanecer desabilitado em produção.

## Limitações conhecidas

Os testes obrigatórios de concorrência multi-processo e crash antes do ACK estão cobertos. O modelo de entrega permanece at-least-once, portanto consumidores externos também precisam ser idempotentes. Autenticação continua intencionalmente fora do escopo e usa um guard no-op. Teste de carga é opcional.

## Limite HTTP

`WalletController` expõe criação e consulta de wallets, ledger paginado por cursor e reconciliação. Um saldo inicial positivo cria uma transação interna `OPENING` processada e uma entrada de crédito imutável, permitindo reconstruir o saldo pelo ledger.

`WageringController` exige o header `Idempotency-Key`, calcula o hash do corpo, delega ao caso de uso e mapeia `PROCESSED` para `201`/`200`, `PENDING_REFERENCE` para `202`, rejeições de negócio para `422`, conflitos de payload para `409`, validações para `400` e indisponibilidade de persistência para `503`.

Os cursores do ledger são objetos JSON codificados em base64url contendo apenas o id da última entrada. O cursor é opaco na borda HTTP e validado antes de chegar ao repositório. O guard de autenticação no-op permanece ativo porque autenticação está fora do escopo do desafio.
