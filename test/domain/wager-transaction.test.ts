import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LedgerDirection } from '../../src/domain/ledger-direction.js';
import { Money } from '../../src/domain/money.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction.js';
import { InvalidDomainInputError, InvalidTransactionStateError } from '../../src/domain/shared/errors.js';

const createProps = (kind: WagerTransactionKind = WagerTransactionKind.Bet) => ({
  id: randomUUID(),
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  idempotencyKey: randomUUID(),
  payloadHash: 'a'.repeat(64),
  walletId: randomUUID(),
  playerId: randomUUID(),
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
});

describe('WagerTransaction', () => {
  test('starts in PENDING and rejects external OPENING', () => {
    const transaction = WagerTransaction.create(createProps());
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(() => WagerTransaction.create(createProps(WagerTransactionKind.Opening)))
      .toThrow(InvalidDomainInputError);
  });

  test('requires references for REFUND and ROLLBACK', () => {
    expect(() => WagerTransaction.create(createProps(WagerTransactionKind.Refund)))
      .toThrow(InvalidDomainInputError);
    expect(() => WagerTransaction.create(createProps(WagerTransactionKind.Rollback)))
      .toThrow(InvalidDomainInputError);
  });

  test('rejects zero-value transactions and rollback of a LOSS', () => {
    expect(() => WagerTransaction.create({
      ...createProps(),
      money: Money.from({ amount: '0.00', currency: 'BRL' }),
    })).toThrow(InvalidDomainInputError);

    const rollback = WagerTransaction.create({
      ...createProps(WagerTransactionKind.Rollback),
      referenceExternalTransactionId: 'loss-1',
    });
    const loss = WagerTransaction.create(createProps(WagerTransactionKind.Loss));

    expect(() => rollback.ledgerDirectionFor(loss)).toThrow(InvalidDomainInputError);
  });

  test('supports pending reference and processed transitions', () => {
    const transaction = WagerTransaction.create({
      ...createProps(WagerTransactionKind.Refund),
      referenceExternalTransactionId: 'bet-1',
    });

    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    transaction.markProcessed('internal-bet-id', new Date('2026-01-01T00:00:00.000Z'));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('internal-bet-id');
    expect(transaction.isTerminal()).toBe(true);
  });

  test('terminal transactions cannot transition again', () => {
    const transaction = WagerTransaction.create(createProps());
    transaction.reject(FailureCode.InsufficientFunds);

    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => transaction.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    expect(() => transaction.fail(FailureCode.InvalidPayload)).toThrow(InvalidTransactionStateError);
  });

  test('calculates balance effects for all operation kinds', () => {
    const bet = WagerTransaction.create(createProps(WagerTransactionKind.Bet));
    const win = WagerTransaction.create(createProps(WagerTransactionKind.Win));
    const loss = WagerTransaction.create(createProps(WagerTransactionKind.Loss));
    const refund = WagerTransaction.create({ ...createProps(WagerTransactionKind.Refund), referenceExternalTransactionId: 'bet-1' });
    const rollback = WagerTransaction.create({ ...createProps(WagerTransactionKind.Rollback), referenceExternalTransactionId: 'win-1' });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(loss.ledgerDirectionFor()).toBe('NONE');
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(loss.affectsBalance()).toBe(false);
  });

  test('matches the persisted payload hash', () => {
    const transaction = WagerTransaction.create(createProps());
    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });
});
