import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Wallet } from '../../../domain/wallet.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletMapper } from '../mappers/wallet.mapper.js';

export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string, lock = false): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(
      WalletEntity,
      { id },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
    return entity ? WalletMapper.toDomain(entity) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string, lock = false): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(
      WalletEntity,
      { playerId, currency },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
    return entity ? WalletMapper.toDomain(entity) : undefined;
  }

  async save(wallet: Wallet): Promise<void> {
    const entity = await this.em.findOne(WalletEntity, { id: wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (entity) {
      WalletMapper.updateEntity(entity, wallet);
      return;
    }
    this.em.persist(WalletMapper.toEntity(wallet));
  }
}
