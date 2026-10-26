import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { InboxMessage, OutboxMessage } from '../../src/domain/messages.js';
import { Money } from '../../src/domain/money.js';
import { WagerTransactionProcessed } from '../../src/domain/integration-events.js';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction.js';
import { InvalidTransactionStateError } from '../../src/domain/shared/errors.js';

describe('Inbox, Outbox and integration events', () => {
  test('inbox transitions once to processed', () => {
    const inbox = InboxMessage.receive({
      consumerName: 'wager-consumer',
      messageId: 'message-1',
      payloadHash: 'a'.repeat(64),
    });

    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date('2026-01-01T00:00:00.000Z'));
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(new Date())).toThrow(InvalidTransactionStateError);
  });

  test('outbox serializes an integration event with string MoneyProps', () => {
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      idempotencyKey: 'provider-a:external-1',
      payloadHash: 'a'.repeat(64),
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const event = WagerTransactionProcessed.from(transaction, {
      eventId: randomUUID(),
      correlationId: 'correlation-1',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const outbox = OutboxMessage.enqueue(event);

    expect(outbox.isPending()).toBe(true);
    expect(outbox.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      data: { money: { amount: '25.00', currency: 'BRL' } },
    });
  });

  test('outbox schedules increasing retries and then publishes', () => {
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    const outbox = OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, {
      eventId: randomUUID(),
      correlationId: 'correlation-1',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    const now = new Date('2026-01-01T00:00:00.000Z');

    outbox.scheduleRetry(now, 'temporary failure');
    expect(outbox.attempts).toBe(1);
    expect(outbox.lastError).toBe('temporary failure');
    expect(outbox.isDue(now)).toBe(false);

    outbox.markPublished(new Date('2026-01-01T00:01:00.000Z'));
    expect(outbox.isPending()).toBe(false);
    expect(() => outbox.scheduleRetry(new Date(), 'late failure')).toThrow(InvalidTransactionStateError);
  });
});
