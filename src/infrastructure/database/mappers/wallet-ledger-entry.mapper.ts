import { LedgerDirection } from '../../../domain/ledger-direction.js';
import { Money } from '../../../domain/money.js';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

export class WalletLedgerEntryMapper {
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      amount: Money.from({ amount: entity.amount, currency: entity.currency }),
      balanceBefore: Money.from({ amount: entity.balanceBefore, currency: entity.currency }),
      balanceAfter: Money.from({ amount: entity.balanceAfter, currency: entity.currency }),
      createdAt: new Date(entity.createdAt.getTime()),
    });
  }

  static toEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.amount.toString();
    entity.currency = entry.amount.currency;
    entity.balanceBefore = entry.balanceBefore.toString();
    entity.balanceAfter = entry.balanceAfter.toString();
    entity.createdAt = new Date(entry.createdAt.getTime());
    return entity;
  }
}
