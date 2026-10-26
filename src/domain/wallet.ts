import { LedgerDirection } from './ledger-direction.js';
import { Money } from './money.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { CurrencyMismatchError, InsufficientFundsError, InvalidDomainInputError } from './shared/errors.js';

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly createdAt?: Date;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovementProps {
  readonly entryId: string;
  readonly transactionId: string;
  readonly amount: Money;
  readonly at?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (!props.id || !props.playerId) {
      throw new InvalidDomainInputError('Wallet identity fields are required');
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidDomainInputError('Wallet initial balance cannot be negative');
    }

    const createdAt = new Date(props.createdAt?.getTime() ?? Date.now());
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      createdAt,
      new Date(createdAt.getTime()),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props.amount);

    if (this._balance.isLessThan(props.amount)) {
      throw new InsufficientFundsError('Wallet balance is insufficient');
    }

    const before = this._balance;
    const after = before.subtract(props.amount);
    this.applyBalance(after, props.at);

    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      amount: props.amount,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props.amount);

    const before = this._balance;
    const after = before.add(props.amount);
    this.applyBalance(after, props.at);

    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      amount: props.amount,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
  }

  private assertMovement(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidDomainInputError('Wallet movement must be positive');
    }

    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet currency is ${this.currency}, received ${amount.currency}`);
    }
  }

  private applyBalance(balance: Money, at?: Date): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date(at?.getTime() ?? Date.now());
  }
}
