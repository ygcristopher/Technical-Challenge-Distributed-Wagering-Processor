import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  IntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/integration-events.js';
import { OutboxMessage } from '../../domain/messages.js';
import { CurrencyMismatchError, InsufficientFundsError } from '../../domain/shared/errors.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import { Wallet } from '../../domain/wallet.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { PersistenceContext, UnitOfWork } from '../../infrastructure/database/unit-of-work.js';

export interface PendingReferenceWorkerResult {
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly rejected: number;
}

const DEFAULT_BATCH_SIZE = 50;

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeRun: Promise<PendingReferenceWorkerResult> | undefined;
  private stopping = false;

  constructor(private readonly unitOfWork: UnitOfWork) {}

  onModuleInit(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === 'false') return;
    const interval = this.readPositiveInteger(process.env.PENDING_REFERENCE_WORKER_INTERVAL_MS, 1000);
    this.timer = setInterval(() => {
      void this.runScheduled();
    }, interval);
    void this.runScheduled();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeRun;
  }

  async runOnce(now = new Date(), limit = DEFAULT_BATCH_SIZE): Promise<PendingReferenceWorkerResult> {
    return this.unitOfWork.execute(async (context) => {
      const pending = await context.transactions.findPendingReferencesDue(now, limit);
      const result = { claimed: pending.length, processed: 0, retried: 0, rejected: 0 };

      for (const transaction of pending) {
        const outcome = await this.processOne(context, transaction, now);
        result[outcome] += 1;
      }

      return result;
    });
  }

  private async runScheduled(): Promise<void> {
    if (this.stopping || this.activeRun) return;
    this.activeRun = this.runOnce()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'pending_reference.worker_failed', error: message }));
        return { claimed: 0, processed: 0, retried: 0, rejected: 0 };
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    await this.activeRun;
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async processOne(
    context: PersistenceContext,
    transaction: WagerTransaction,
    now: Date,
  ): Promise<'processed' | 'retried' | 'rejected'> {
    const reference = transaction.referenceExternalTransactionId
      ? await context.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId, true)
      : undefined;

    if (!reference) {
      if (transaction.hasReferenceRetryExpired(now)) {
        transaction.reject(FailureCode.ReferenceNotFound);
        await this.persistRejected(context, transaction, now);
        return 'rejected';
      }

      transaction.scheduleReferenceRetry(now);
      await context.transactions.save(transaction);
      return 'retried';
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      if (reference.isTerminal()) {
        transaction.reject(FailureCode.InvalidReferenceKind);
        await this.persistRejected(context, transaction, now);
        return 'rejected';
      }
      if (transaction.hasReferenceRetryExpired(now)) {
        transaction.reject(FailureCode.ReferenceNotFound);
        await this.persistRejected(context, transaction, now);
        return 'rejected';
      }
      transaction.scheduleReferenceRetry(now);
      await context.transactions.save(transaction);
      return 'retried';
    }

    const validationFailure = this.validateReference(transaction, reference);
    if (validationFailure) {
      transaction.reject(validationFailure);
      await this.persistRejected(context, transaction, now);
      return 'rejected';
    }

    const existingReversal = await context.transactions.findActiveReversal(reference.id, transaction.kind);
    if (existingReversal) {
      transaction.reject(FailureCode.AlreadyReversed);
      await this.persistRejected(context, transaction, now);
      return 'rejected';
    }

    const wallet = await context.wallets.findById(transaction.walletId, true);
    if (!wallet) {
      transaction.reject(FailureCode.WalletNotFound);
      await this.persistRejected(context, transaction, now);
      return 'rejected';
    }

    try {
      const entry = this.applyReversal(transaction, reference, wallet, now);
      transaction.markProcessed(reference.id, now);
      await context.wallets.save(wallet);
      await context.ledger.save(entry);
      await context.transactions.save(transaction);
      await context.flush();
      await context.outbox.save(OutboxMessage.enqueue(this.processedEvent(transaction, now)));
      await context.outbox.save(OutboxMessage.enqueue(this.balanceEvent(transaction, wallet, entry, now)));
      return 'processed';
    } catch (error: unknown) {
      transaction.reject(mapReversalFailure(transaction, error));
      await this.persistRejected(context, transaction, now);
      return 'rejected';
    }
  }

  private validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): FailureCode | undefined {
    if (reference.walletId !== transaction.walletId || reference.playerId !== transaction.playerId) {
      return FailureCode.InvalidReferenceKind;
    }
    if (reference.roundId !== transaction.roundId) {
      return FailureCode.InvalidReferenceKind;
    }
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.InvalidPayload;
    }
    if (transaction.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      return FailureCode.InvalidReferenceKind;
    }
    if (transaction.kind === WagerTransactionKind.Rollback && reference.kind === WagerTransactionKind.Loss) {
      return FailureCode.InvalidReferenceKind;
    }
    return undefined;
  }

  private applyReversal(
    transaction: WagerTransaction,
    reference: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): WalletLedgerEntry {
    const movement = {
      entryId: randomUUID(),
      transactionId: transaction.id,
      amount: transaction.money,
      at: now,
    };

    if (transaction.kind === WagerTransactionKind.Refund) {
      return wallet.credit(movement);
    }

    return reference.ledgerDirectionFor() === 'DEBIT'
      ? wallet.credit(movement)
      : wallet.debit(movement);
  }

  private async persistRejected(
    context: PersistenceContext,
    transaction: WagerTransaction,
    now: Date,
  ): Promise<void> {
    await context.transactions.save(transaction);
    await context.flush();
    await context.outbox.save(OutboxMessage.enqueue(this.rejectedEvent(transaction, now)));
  }

  private processedEvent(transaction: WagerTransaction, occurredAt: Date): IntegrationEvent<unknown> {
    return WagerTransactionProcessed.from(transaction, {
      eventId: randomUUID(),
      correlationId: transaction.idempotencyKey,
      occurredAt,
    });
  }

  private rejectedEvent(transaction: WagerTransaction, occurredAt: Date): IntegrationEvent<unknown> {
    return WagerTransactionRejected.from(transaction, {
      eventId: randomUUID(),
      correlationId: transaction.idempotencyKey,
      occurredAt,
    });
  }

  private balanceEvent(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    occurredAt: Date,
  ): IntegrationEvent<unknown> {
    return WalletBalanceChanged.from(wallet, entry, {
      eventId: randomUUID(),
      correlationId: transaction.idempotencyKey,
      occurredAt,
    });
  }
}

function mapReversalFailure(transaction: WagerTransaction, error: unknown): FailureCode {
  if (error instanceof InsufficientFundsError && transaction.kind === WagerTransactionKind.Rollback) {
    return FailureCode.InsufficientFundsForReversal;
  }
  if (error instanceof CurrencyMismatchError) {
    return FailureCode.CurrencyMismatch;
  }
  return FailureCode.InvalidPayload;
}
