import { LedgerDirection } from './ledger-direction.js';
import { Money } from './money.js';
import { CurrencyMismatchError, InvalidDomainInputError } from './shared/errors.js';

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt?: Date | undefined;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly amount: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvalidDomainInputError('Ledger identity fields are required');
    }

    if (!props.amount.isPositive()) {
      throw new InvalidDomainInputError('Ledger amount must be positive');
    }

    if (props.balanceBefore.currency !== props.amount.currency || props.balanceAfter.currency !== props.amount.currency) {
      throw new CurrencyMismatchError('Ledger values must use the same currency');
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidDomainInputError('Ledger balances cannot be negative');
    }

    const expectedAfter = props.direction === LedgerDirection.Debit
      ? props.balanceBefore.subtract(props.amount)
      : props.balanceBefore.add(props.amount);

    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new InvalidDomainInputError('Ledger arithmetic is not balanced');
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.amount,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt?.getTime() ?? Date.now()),
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.amount,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  isBalanced(): boolean {
    const expectedAfter = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.amount)
      : this.balanceBefore.add(this.amount);
    return expectedAfter.equals(this.balanceAfter);
  }
}
