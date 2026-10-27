import { randomUUID } from 'node:crypto';
import { IntegrationEvent } from '../../domain/integration-events.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wager-transaction.js';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/integration-events.js';
import { Money, MoneyProps } from '../../domain/money.js';
import { OutboxMessage } from '../../domain/messages.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { Wallet } from '../../domain/wallet.js';
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
  InvalidDomainInputError,
} from '../../domain/shared/errors.js';
import { Result } from '../shared/result.js';
import { PersistenceContext, UnitOfWork } from '../../infrastructure/database/unit-of-work.js';

export interface ProcessWagerTransactionInput {
  readonly id?: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly occurredAt?: Date;
}

export interface ProcessWagerTransactionOutput {
  readonly transaction: WagerTransaction;
  readonly ledgerEntry?: WalletLedgerEntry;
  readonly idempotentReplay: boolean;
}

export interface UseCaseError {
  readonly code: FailureCode | 'IDEMPOTENCY_CONFLICT' | 'PERSISTENCE_ERROR';
  readonly message: string;
}

export class ProcessWagerTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<Result<ProcessWagerTransactionOutput, UseCaseError>> {
    try {
      return await this.unitOfWork.execute((context) => this.process(context, input));
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return this.resolveConcurrentInsert(input);
      }
      if (error instanceof DomainError) {
        return Result.err<UseCaseError>({ code: FailureCode.InvalidPayload, message: error.message });
      }
      return Result.err<UseCaseError>({ code: 'PERSISTENCE_ERROR', message: 'Could not persist wager transaction' });
    }
  }

  private async resolveConcurrentInsert(
    input: ProcessWagerTransactionInput,
  ): Promise<Result<ProcessWagerTransactionOutput, UseCaseError>> {
    return this.unitOfWork.execute(async (context) => {
      const existing = await context.transactions.findByIdempotency(input.providerId, input.idempotencyKey)
        ?? await context.transactions.findByExternalId(input.providerId, input.externalTransactionId);

      if (!existing) {
        return Result.err<UseCaseError>({ code: 'PERSISTENCE_ERROR', message: 'Concurrent insert could not be resolved' });
      }
      return this.replayOrConflict(existing, input.payloadHash);
    }).catch(() => Result.err<UseCaseError>({ code: 'PERSISTENCE_ERROR', message: 'Could not resolve idempotency race' }));
  }

  private async process(
    context: PersistenceContext,
    input: ProcessWagerTransactionInput,
  ): Promise<Result<ProcessWagerTransactionOutput, UseCaseError>> {
    const existing = await context.transactions.findByIdempotency(input.providerId, input.idempotencyKey)
      ?? await context.transactions.findByExternalId(input.providerId, input.externalTransactionId);
    if (existing) {
      return this.replayOrConflict(existing, input.payloadHash);
    }

    const transaction = WagerTransaction.create({
      id: input.id ?? randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: Money.from(input.money),
      ...(input.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
      ...(input.occurredAt !== undefined ? { createdAt: input.occurredAt } : {}),
    });

    await context.transactions.save(transaction);
    await context.flush();

    if (transaction.requiresReference()) {
      transaction.markPendingReference();
      await context.transactions.save(transaction);
      await this.enqueuePendingReference(context, transaction, input);
      return Result.ok({ transaction, idempotentReplay: false });
    }

    const wallet = await context.wallets.findById(transaction.walletId, true);
    if (!wallet) {
      transaction.reject(FailureCode.WalletNotFound);
      await this.persistRejected(context, transaction, input);
      return Result.ok({ transaction, idempotentReplay: false });
    }

    let ledgerEntry: WalletLedgerEntry | undefined;
    try {
      if (transaction.kind === WagerTransactionKind.Bet) {
        ledgerEntry = wallet.debit({
          entryId: randomUUID(),
          transactionId: transaction.id,
          amount: transaction.money,
          ...(input.occurredAt !== undefined ? { at: input.occurredAt } : {}),
        });
      } else if (transaction.kind === WagerTransactionKind.Win) {
        ledgerEntry = wallet.credit({
          entryId: randomUUID(),
          transactionId: transaction.id,
          amount: transaction.money,
          ...(input.occurredAt !== undefined ? { at: input.occurredAt } : {}),
        });
      }
    } catch (error: unknown) {
      transaction.reject(mapBusinessFailure(error));
      await this.persistRejected(context, transaction, input);
      return Result.ok({ transaction, idempotentReplay: false });
    }

    transaction.markProcessed(undefined, input.occurredAt ?? new Date());
    await context.wallets.save(wallet);
    if (ledgerEntry) {
      await context.ledger.save(ledgerEntry);
    }
    await context.transactions.save(transaction);
    await context.flush();
    await context.outbox.save(OutboxMessage.enqueue(this.processedEvent(transaction, input)));
    if (ledgerEntry) {
      await context.outbox.save(OutboxMessage.enqueue(this.balanceEvent(transaction, wallet, ledgerEntry, input)));
    }

    return Result.ok({ transaction, ...(ledgerEntry ? { ledgerEntry } : {}), idempotentReplay: false });
  }

  private replayOrConflict(
    transaction: WagerTransaction,
    payloadHash: string,
  ): Result<ProcessWagerTransactionOutput, UseCaseError> {
    if (!transaction.matchesPayload(payloadHash)) {
      return Result.err({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was reused with a different payload' });
    }

    return Result.ok({ transaction, idempotentReplay: true });
  }

  private async persistRejected(
    context: PersistenceContext,
    transaction: WagerTransaction,
    input: ProcessWagerTransactionInput,
  ): Promise<void> {
    await context.transactions.save(transaction);
    await context.flush();
    await context.outbox.save(OutboxMessage.enqueue(this.rejectedEvent(transaction, input)));
  }

  private async enqueuePendingReference(
    context: PersistenceContext,
    transaction: WagerTransaction,
    input: ProcessWagerTransactionInput,
  ): Promise<void> {
    await context.flush();
    await context.outbox.save(OutboxMessage.enqueue(
      WagerTransactionPendingReference.from(transaction, this.eventContext(input)),
    ));
  }

  private processedEvent(transaction: WagerTransaction, input: ProcessWagerTransactionInput): IntegrationEvent<unknown> {
    return WagerTransactionProcessed.from(transaction, this.eventContext(input));
  }

  private rejectedEvent(transaction: WagerTransaction, input: ProcessWagerTransactionInput): IntegrationEvent<unknown> {
    return WagerTransactionRejected.from(transaction, this.eventContext(input));
  }

  private balanceEvent(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    input: ProcessWagerTransactionInput,
  ): IntegrationEvent<unknown> {
    return WalletBalanceChanged.from(wallet, entry, this.eventContext(input));
  }

  private eventContext(input: ProcessWagerTransactionInput): {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
  } {
    return {
      eventId: randomUUID(),
      correlationId: input.correlationId ?? input.idempotencyKey,
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      occurredAt: input.occurredAt ?? new Date(),
    };
  }
}

function mapBusinessFailure(error: unknown): FailureCode {
  if (error instanceof InsufficientFundsError) {
    return FailureCode.InsufficientFunds;
  }
  if (error instanceof CurrencyMismatchError) {
    return FailureCode.CurrencyMismatch;
  }
  if (error instanceof InvalidDomainInputError) {
    return FailureCode.InvalidPayload;
  }
  return FailureCode.InvalidPayload;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}
