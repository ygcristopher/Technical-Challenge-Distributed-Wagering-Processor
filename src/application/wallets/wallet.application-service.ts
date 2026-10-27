import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Money } from '../../domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import { DomainError } from '../../domain/shared/errors.js';
import { LedgerDirection } from '../../domain/ledger-direction.js';
import { OutboxMessage } from '../../domain/messages.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import { WagerTransactionProcessed } from '../../domain/integration-events.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { Injectable } from '@nestjs/common';
import { Result } from '../shared/result.js';
import { UnitOfWork } from '../../infrastructure/database/unit-of-work.js';

export interface CreateWalletInput {
  readonly id?: string;
  readonly playerId: string;
  readonly currency: string;
  readonly initialBalance: string;
}

export interface ReconciliationOutput {
  readonly walletId: string;
  readonly walletBalance: string;
  readonly ledgerBalance: string;
  readonly debitTotal: string;
  readonly creditTotal: string;
  readonly entryCount: number;
  readonly matches: boolean;
}

@Injectable()
export class WalletApplicationService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async create(input: CreateWalletInput): Promise<Result<Wallet, 'INVALID_INPUT' | 'CONFLICT' | 'PERSISTENCE_ERROR'>> {
    try {
      const wallet = Wallet.open({
        id: input.id ?? randomUUID(),
        playerId: input.playerId,
        initialBalance: Money.from({ amount: input.initialBalance, currency: input.currency }),
      });
      await this.unitOfWork.execute(async (context) => {
        await context.wallets.save(wallet);
        await context.flush();
        if (!wallet.balance.isPositive()) {
          return;
        }

        const opening = WagerTransaction.createOpening({
          id: randomUUID(),
          providerId: 'system',
          externalTransactionId: `wallet-opening-${wallet.id}`,
          idempotencyKey: `wallet-opening-${wallet.id}`,
          payloadHash: createHash('sha256').update(`wallet-opening:${wallet.id}`).digest('hex'),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'wallet-opening',
          gameId: 'wallet-opening',
          money: wallet.balance,
          createdAt: wallet.createdAt,
        });
        opening.markProcessed(undefined, wallet.createdAt);
        await context.transactions.save(opening);
        await context.flush();
        await context.ledger.save(WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          amount: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: wallet.createdAt,
        }));
        await context.outbox.save(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, {
          eventId: randomUUID(),
          correlationId: `wallet-opening-${wallet.id}`,
          occurredAt: wallet.createdAt,
        })));
      });
      return Result.ok(wallet);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'UniqueConstraintViolationException') {
        return Result.err('CONFLICT');
      }
      if (error instanceof DomainError) {
        return Result.err('INVALID_INPUT');
      }
      return Result.err('PERSISTENCE_ERROR');
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.unitOfWork.execute(({ wallets }) => wallets.findById(id));
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.unitOfWork.execute(({ wallets }) => wallets.findByPlayerAndCurrency(playerId, currency));
  }

  async ledger(walletId: string, limit: number, cursor?: string) {
    return this.unitOfWork.execute(({ ledger }) => ledger.findByWalletId(walletId, limit + 1, cursor));
  }

  async reconcile(walletId: string): Promise<ReconciliationOutput | undefined> {
    return this.unitOfWork.execute(async (context) => {
      const wallet = await context.wallets.findById(walletId);
      if (!wallet) {
        return undefined;
      }
      const totals = await context.ledger.reconcile(walletId, wallet.currency);
      const walletBalance = new Decimal(wallet.balance.toString());
      const ledgerBalance = new Decimal(totals.ledgerBalance);
      return {
        walletId,
        walletBalance: wallet.balance.toString(),
        ledgerBalance: ledgerBalance.toFixed(2),
        debitTotal: totals.debitTotal,
        creditTotal: totals.creditTotal,
        entryCount: totals.entryCount,
        matches: walletBalance.equals(ledgerBalance),
      };
    });
  }
}
