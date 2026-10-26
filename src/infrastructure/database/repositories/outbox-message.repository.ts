import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../../domain/messages.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { MessagesMapper } from '../mappers/messages.mapper.js';

export class OutboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string, lock = false): Promise<OutboxMessage | undefined> {
    const entity = await this.em.findOne(
      OutboxMessageEntity,
      { id },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
    return entity ? MessagesMapper.outboxToDomain(entity) : undefined;
  }

  async findDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const entities = await this.em.find(
      OutboxMessageEntity,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: 'ASC', occurredAt: 'ASC' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return entities.map(MessagesMapper.outboxToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const entity = await this.em.findOne(
      OutboxMessageEntity,
      { id: message.id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (entity) {
      MessagesMapper.outboxToEntity(message);
      const updated = MessagesMapper.outboxToEntity(message);
      Object.assign(entity, updated);
      return;
    }
    this.em.persist(MessagesMapper.outboxToEntity(message));
  }
}
