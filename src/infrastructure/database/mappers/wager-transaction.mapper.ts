import { Money } from '../../../domain/money.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

export class WagerTransactionMapper {
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const state: WagerTransactionState = {
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: Money.from({ amount: entity.moneyAmount, currency: entity.currency }),
      createdAt: new Date(entity.createdAt.getTime()),
      status: entity.status as WagerTransactionStatus,
      attempts: entity.attempts,
      ...(entity.referenceExternalTransactionId !== null
        ? { referenceExternalTransactionId: entity.referenceExternalTransactionId }
        : {}),
      ...(entity.referenceTransactionId !== null ? { referenceTransactionId: entity.referenceTransactionId } : {}),
      ...(entity.failureCode !== null ? { failureCode: entity.failureCode as FailureCode } : {}),
      ...(entity.processedAt !== null ? { processedAt: new Date(entity.processedAt.getTime()) } : {}),
      ...(entity.nextAttemptAt !== null ? { nextAttemptAt: new Date(entity.nextAttemptAt.getTime()) } : {}),
    };
    return WagerTransaction.rehydrate(state);
  }

  static toEntity(transaction: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    this.updateEntity(entity, transaction);
    return entity;
  }

  static updateEntity(entity: WagerTransactionEntity, transaction: WagerTransaction): void {
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.moneyAmount = transaction.money.toString();
    entity.currency = transaction.money.currency;
    entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
    entity.status = transaction.status;
    entity.failureCode = transaction.failureCode ?? null;
    entity.attempts = transaction.attempts;
    entity.nextAttemptAt = transaction.nextAttemptAt ?? null;
    entity.createdAt = new Date(transaction.createdAt.getTime());
    entity.processedAt = transaction.processedAt ?? null;
  }
}
