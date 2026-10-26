import { LedgerDirection, LedgerEffect } from './ledger-direction.js';
import { Money } from './money.js';
import { InvalidDomainInputError, InvalidTransactionStateError } from './shared/errors.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InsufficientFundsForReversal = 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AlreadyReversed = 'ALREADY_REVERSED',
  InvalidPayload = 'INVALID_PAYLOAD',
  WalletNotFound = 'WALLET_NOT_FOUND',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidDomainInputError('OPENING transactions are internal only');
    }

    return WagerTransaction.build(props, WagerTransactionStatus.Pending, undefined, undefined, undefined);
  }

  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind'>): WagerTransaction {
    return WagerTransaction.build(
      { ...props, kind: WagerTransactionKind.Opening },
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(
      state,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidDomainInputError('This transaction requires a reference');
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = new Date(at.getTime());
  }

  markPendingReference(): void {
    this.assertMutable();
    if (!this.requiresReference()) {
      throw new InvalidDomainInputError('Only reference-based transactions can wait for a reference');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertMutable();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertMutable();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed
      || this._status === WagerTransactionStatus.Rejected
      || this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerEffect {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return 'NONE';
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidDomainInputError('ROLLBACK requires the referenced transaction');
        }
        const referenceDirection = reference.ledgerDirectionFor();
        if (referenceDirection === 'NONE') {
          throw new InvalidDomainInputError('ROLLBACK cannot reference a transaction without a ledger effect');
        }
        return referenceDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
    }
  }

  private static build(
    props: CreateWagerTransactionProps,
    status: WagerTransactionStatus,
    referenceTransactionId: string | undefined,
    failureCode: FailureCode | undefined,
    processedAt: Date | undefined,
  ): WagerTransaction {
    if (!props.id || !props.providerId || !props.externalTransactionId || !props.idempotencyKey || !props.payloadHash) {
      throw new InvalidDomainInputError('Transaction identity fields are required');
    }

    if (!props.walletId || !props.playerId || !props.roundId || !props.gameId) {
      throw new InvalidDomainInputError('Transaction context fields are required');
    }

    if (!props.money.isPositive()) {
      throw new InvalidDomainInputError('Transaction money must be positive');
    }

    if (getRequiresReference(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidDomainInputError('REFUND and ROLLBACK require a reference transaction');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt?.getTime() ?? Date.now()),
      status,
      referenceTransactionId,
      failureCode,
      processedAt ? new Date(processedAt.getTime()) : undefined,
    );
  }

  private assertMutable(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} is already terminal`);
    }
  }
}

function getRequiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}
