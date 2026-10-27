import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { Money } from '../../src/domain/money.js';
import { InboxMessage, OutboxMessage } from '../../src/domain/messages.js';
import { WagerTransactionProcessed } from '../../src/domain/integration-events.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction.js';
import { Wallet } from '../../src/domain/wallet.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
} from '../../src/application/wagering/process-wager-transaction.use-case.js';
import { PendingReferenceWorker } from '../../src/application/wagering/pending-reference.worker.js';

describe('MikroORM persistence and UnitOfWork', () => {
  let orm: MikroORM;
  let unitOfWork: UnitOfWork;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    unitOfWork = new UnitOfWork(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('persists and rehydrates all domain aggregates without losing decimal precision', async () => {
    const walletId = randomUUID();
    const transactionId = randomUUID();
    const entryId = randomUUID();
    const playerId = randomUUID();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const wallet = await unitOfWork.execute(async ({ wallets }) => {
      const newWallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
        createdAt: timestamp,
      });
      await wallets.save(newWallet);
      return newWallet;
    });

    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId: 'provider-persistence',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'b'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-persistence',
      gameId: 'game-persistence',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '12.34', currency: 'BRL' }),
      createdAt: timestamp,
    });
    const entry = wallet.credit({
      entryId,
      transactionId,
      amount: transaction.money,
      at: timestamp,
    });
    transaction.markProcessed(undefined, timestamp);
    const inbox = InboxMessage.receive({
      consumerName: 'persistence-test',
      messageId: randomUUID(),
      payloadHash: 'c'.repeat(64),
      receivedAt: timestamp,
    });
    inbox.markProcessed(timestamp);
    const outbox = OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, {
      eventId: randomUUID(),
      correlationId: 'persistence-correlation',
      occurredAt: timestamp,
    }));

    await unitOfWork.execute(async (context) => {
      await context.transactions.save(transaction);
      await context.flush();
      await context.ledger.save(entry);
      await context.inbox.save(inbox);
      await context.outbox.save(outbox);
    });

    const restored = await unitOfWork.execute(async (context) => ({
      wallet: await context.wallets.findById(walletId),
      transaction: await context.transactions.findById(transactionId),
      ledger: await context.ledger.findByTransactionId(transactionId),
      inbox: await context.inbox.find(inbox.consumerName, inbox.messageId),
      outbox: await context.outbox.findById(outbox.id),
    }));

    expect(restored.wallet?.balance.toString()).toBe('100.00');
    expect(restored.transaction?.money.toString()).toBe('12.34');
    expect(restored.transaction?.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.ledger?.balanceAfter.toString()).toBe('112.34');
    expect(restored.inbox?.isProcessed()).toBe(true);
    expect(restored.outbox?.payload).toMatchObject({
      data: { money: { amount: '12.34', currency: 'BRL' } },
    });
  });

  test('rolls back every persisted change when the UnitOfWork callback fails', async () => {
    const walletId = randomUUID();

    await expect(unitOfWork.execute(async ({ wallets }) => {
      await wallets.save(Wallet.open({
        id: walletId,
        playerId: randomUUID(),
        initialBalance: Money.zero('BRL'),
      }));
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    const found = await unitOfWork.execute(({ wallets }) => wallets.findById(walletId));
    expect(found).toBeUndefined();
  });

  test('serializes two concurrent bets against the same wallet', async () => {
    const walletId = randomUUID();
    await unitOfWork.execute(({ wallets }) => wallets.save(Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    })));

    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    const inputs = [1, 2].map((index) => ({
      providerId: 'provider-concurrency',
      externalTransactionId: `bet-${randomUUID()}`,
      idempotencyKey: `bet-key-${index}-${randomUUID()}`,
      payloadHash: `${index}`.repeat(64),
      walletId,
      playerId: randomUUID(),
      roundId: 'round-concurrency',
      gameId: 'game-concurrency',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    } satisfies ProcessWagerTransactionInput));

    const results = await Promise.all(inputs.map((input) => useCase.execute(input)));
    const processed = results.filter((result) => result.ok && result.value.transaction.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((result) => result.ok && result.value.transaction.status === WagerTransactionStatus.Rejected);

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.ok && rejected[0].value.transaction.failureCode).toBe(FailureCode.InsufficientFunds);

    const state = await unitOfWork.execute(async ({ wallets }) => wallets.findById(walletId));
    expect(state?.balance.toString()).toBe('20.00');
  });

  test('applies one effect for fifty identical requests in parallel', async () => {
    const walletId = randomUUID();
    await unitOfWork.execute(({ wallets }) => wallets.save(Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '1000.00', currency: 'BRL' }),
    })));

    const input: ProcessWagerTransactionInput = {
      id: randomUUID(),
      providerId: 'provider-idempotency',
      externalTransactionId: `bet-${randomUUID()}`,
      idempotencyKey: `same-key-${randomUUID()}`,
      payloadHash: 'd'.repeat(64),
      walletId,
      playerId: randomUUID(),
      roundId: 'round-idempotency',
      gameId: 'game-idempotency',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(input)));

    expect(results.every((result) => result.ok)).toBe(true);
    const replays = results.filter((result) => result.ok && result.value.idempotentReplay);
    expect(replays).toHaveLength(49);

    const state = await unitOfWork.execute(async ({ wallets }) => wallets.findById(walletId));
    expect(state?.balance.toString()).toBe('990.00');
    const count = await orm.em.getConnection().execute<Array<{ count: string }>>(
      'SELECT count(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ?',
      [walletId],
    );
    expect(count[0]?.count).toBe('1');
  });

  test('processes a REFUND that arrived before its BET reference', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const betExternalId = `bet-reference-${randomUUID()}`;
    const refundExternalId = `refund-reference-${randomUUID()}`;
    await unitOfWork.execute(({ wallets }) => wallets.save(Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    })));

    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    const refund = await useCase.execute({
      providerId: 'provider-reference',
      externalTransactionId: refundExternalId,
      idempotencyKey: `refund-key-${randomUUID()}`,
      payloadHash: 'e'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-reference',
      gameId: 'game-reference',
      kind: WagerTransactionKind.Refund,
      money: { amount: '20.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(refund.ok && refund.value.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = await useCase.execute({
      providerId: 'provider-reference',
      externalTransactionId: betExternalId,
      idempotencyKey: `bet-key-${randomUUID()}`,
      payloadHash: 'f'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-reference',
      gameId: 'game-reference',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(bet.ok).toBe(true);

    const worker = new PendingReferenceWorker(unitOfWork);
    const result = await worker.runOnce(new Date(), 10);
    expect(result.processed).toBe(1);

    const state = await unitOfWork.execute(async (context) => ({
      wallet: await context.wallets.findById(walletId),
      refund: await context.transactions.findByExternalId('provider-reference', refundExternalId),
    }));
    expect(state.wallet?.balance.toString()).toBe('100.00');
    expect(state.refund?.status).toBe(WagerTransactionStatus.Processed);
  });

  test('rejects a pending reference after its retry age is exhausted', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const createdAt = new Date(Date.now() - 3_600_001);
    const externalTransactionId = `refund-expired-${randomUUID()}`;
    await unitOfWork.execute(({ wallets }) => wallets.save(Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    })));

    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute({
      providerId: 'provider-expired-reference',
      externalTransactionId,
      idempotencyKey: `expired-key-${randomUUID()}`,
      payloadHash: '1'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-expired',
      gameId: 'game-expired',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: `missing-${randomUUID()}`,
      occurredAt: createdAt,
    });

    const worker = new PendingReferenceWorker(unitOfWork);
    const result = await worker.runOnce(new Date(), 10);
    expect(result.rejected).toBe(1);

    const transaction = await unitOfWork.execute(({ transactions }) =>
      transactions.findByExternalId('provider-expired-reference', externalTransactionId));
    expect(transaction?.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction?.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('rolls back a BET once and rejects a second rollback', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const betExternalId = `bet-rollback-${randomUUID()}`;
    await unitOfWork.execute(({ wallets }) => wallets.save(Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    })));

    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    const bet = await useCase.execute({
      providerId: 'provider-rollback',
      externalTransactionId: betExternalId,
      idempotencyKey: `bet-key-${randomUUID()}`,
      payloadHash: '2'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-rollback',
      gameId: 'game-rollback',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(bet.ok).toBe(true);

    const rollbackInput: ProcessWagerTransactionInput = {
      providerId: 'provider-rollback',
      externalTransactionId: `rollback-${randomUUID()}`,
      idempotencyKey: `rollback-key-${randomUUID()}`,
      payloadHash: '3'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-rollback',
      gameId: 'game-rollback',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    };
    const first = await useCase.execute(rollbackInput);
    expect(first.ok && first.value.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    const worker = new PendingReferenceWorker(unitOfWork);
    expect((await worker.runOnce(new Date(), 10)).processed).toBe(1);

    const second = await useCase.execute({
      ...rollbackInput,
      id: randomUUID(),
      externalTransactionId: `rollback-${randomUUID()}`,
      idempotencyKey: `rollback-key-${randomUUID()}`,
      payloadHash: '4'.repeat(64),
    });
    expect(second.ok && second.value.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect((await worker.runOnce(new Date(), 10)).rejected).toBe(1);

    const state = await unitOfWork.execute(async (context) => ({
      wallet: await context.wallets.findById(walletId),
      transaction: await context.transactions.findByExternalId('provider-rollback', second.ok ? second.value.transaction.externalTransactionId : ''),
    }));
    expect(state.wallet?.balance.toString()).toBe('100.00');
    expect(state.transaction?.failureCode).toBe(FailureCode.AlreadyReversed);
  });
});
