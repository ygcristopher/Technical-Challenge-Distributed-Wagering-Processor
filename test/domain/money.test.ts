import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/shared/errors.js';

describe('Money', () => {
  test('normalizes valid decimal strings to exactly two places', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
    expect(Money.from({ amount: '25.1', currency: 'BRL' }).toString()).toBe('25.10');
    expect(Money.from({ amount: '25.10', currency: 'BRL' }).toJSON()).toEqual({ amount: '25.10', currency: 'BRL' });
  });

  test('rejects invalid decimal representations', () => {
    for (const amount of ['', ' ', '-1.00', '1.001', '1e2', 'NaN', 'Infinity']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  test('rejects invalid currencies', () => {
    for (const currency of ['', 'brl', 'BR', 'BRLL']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    }
  });

  test('is immutable and performs exact decimal arithmetic', () => {
    const original = Money.from({ amount: '10.10', currency: 'BRL' });
    const result = original.add(Money.from({ amount: '0.20', currency: 'BRL' }));

    expect(original.toString()).toBe('10.10');
    expect(result.toString()).toBe('10.30');
    expect(result.subtract(original).toString()).toBe('0.20');
    expect(result.negate().toString()).toBe('-10.30');
    expect(result.isPositive()).toBe(true);
    expect(result.negate().isNegative()).toBe(true);
  });

  test('rejects arithmetic between different currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });
});
