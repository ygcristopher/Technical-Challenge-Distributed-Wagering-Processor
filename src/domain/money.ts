import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './shared/errors.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const MONEY_SCALE = 2;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = props.currency;
    const amount = props.amount;

    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be an uppercase ISO-4217 code');
    }

    if (!NON_NEGATIVE_DECIMAL_PATTERN.test(amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal with at most 2 places');
    }

    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromInternal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromInternal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromInternal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  private static fromInternal(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyError('Money arithmetic produced an invalid scale or value');
    }

    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} and ${other.currency}`);
    }
  }
}
