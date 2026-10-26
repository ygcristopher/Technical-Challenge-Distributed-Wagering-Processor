import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { Money } from '../../src/domain/money.js';
import { InboxMessage, OutboxMessage } from '../../src/domain/messages.js';
import { WagerTransactionProcessed } from '../../src/domain/integration-events.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction.js';
import { Wallet } from '../../src/domain/wallet.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';

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
});
