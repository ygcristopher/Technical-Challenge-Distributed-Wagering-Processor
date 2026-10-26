import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WagerTransaction } from '../../../domain/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper.js';

export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string, lock = false): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(
      WagerTransactionEntity,
      { id },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async findByIdempotency(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, idempotencyKey });
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string, lock = false): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(
      WagerTransactionEntity,
      { providerId, externalTransactionId },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
    return entity ? WagerTransactionMapper.toDomain(entity) : undefined;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const entity = await this.em.findOne(
      WagerTransactionEntity,
      { id: transaction.id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (entity) {
      WagerTransactionMapper.updateEntity(entity, transaction);
      return;
    }
    this.em.persist(WagerTransactionMapper.toEntity(transaction));
  }
}
