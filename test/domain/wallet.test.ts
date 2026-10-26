import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LedgerDirection } from '../../src/domain/ledger-direction.js';
import { Money } from '../../src/domain/money.js';
import { Wallet } from '../../src/domain/wallet.js';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry.js';
import { CurrencyMismatchError, InsufficientFundsError, InvalidDomainInputError } from '../../src/domain/shared/errors.js';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

describe('Wallet and WalletLedgerEntry', () => {
  test('opens with version one and debits atomically in the aggregate', () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: 'player-1', initialBalance: money('100.00') });
    const entry = wallet.debit({ entryId: randomUUID(), transactionId: randomUUID(), amount: money('30.00') });

    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credits and increments version only when balance changes', () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: 'player-1', initialBalance: money('0.00') });
    wallet.credit({ entryId: randomUUID(), transactionId: randomUUID(), amount: money('25.00') });

    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(2);
  });

  test('rejects insufficient funds without mutating the wallet', () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: 'player-1', initialBalance: money('10.00') });

    expect(() => wallet.debit({ entryId: randomUUID(), transactionId: randomUUID(), amount: money('10.01') }))
      .toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('rejects negative movements and currency conflicts', () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: 'player-1', initialBalance: money('10.00') });

    expect(() => wallet.credit({ entryId: randomUUID(), transactionId: randomUUID(), amount: money('0.00') }))
      .toThrow(InvalidDomainInputError);
    expect(() => wallet.credit({ entryId: randomUUID(), transactionId: randomUUID(), amount: money('1.00', 'USD') }))
      .toThrow(CurrencyMismatchError);
  });

  test('validates ledger arithmetic and currency independently', () => {
    expect(() => WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: randomUUID(),
      transactionId: randomUUID(),
      direction: LedgerDirection.Debit,
      amount: money('10.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('91.00'),
    })).toThrow(InvalidDomainInputError);

    expect(() => WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: randomUUID(),
      transactionId: randomUUID(),
      direction: LedgerDirection.Credit,
      amount: money('10.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('110.00', 'USD'),
    })).toThrow(CurrencyMismatchError);
  });
});
