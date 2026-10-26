import { Money } from '../../../domain/money.js';
import { Wallet, WalletState } from '../../../domain/wallet.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class WalletMapper {
  static toDomain(entity: WalletEntity): Wallet {
    const state: WalletState = {
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({ amount: entity.balance, currency: entity.currency }),
      version: entity.version,
      createdAt: new Date(entity.createdAt.getTime()),
      updatedAt: new Date(entity.updatedAt.getTime()),
    };
    return Wallet.rehydrate(state);
  }

  static toEntity(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    this.updateEntity(entity, wallet);
    return entity;
  }

  static updateEntity(entity: WalletEntity, wallet: Wallet): void {
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balance = wallet.balance.toString();
    entity.version = wallet.version;
    entity.createdAt = new Date(wallet.createdAt.getTime());
    entity.updatedAt = new Date(wallet.updatedAt.getTime());
  }
}
