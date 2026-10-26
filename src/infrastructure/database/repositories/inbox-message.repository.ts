import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../domain/messages.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';
import { MessagesMapper } from '../mappers/messages.mapper.js';

export class InboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string, lock = false): Promise<InboxMessage | undefined> {
    const entity = await this.em.findOne(
      InboxMessageEntity,
      { consumerName, messageId },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
    return entity ? MessagesMapper.inboxToDomain(entity) : undefined;
  }

  async save(message: InboxMessage): Promise<void> {
    const entity = await this.em.findOne(
      InboxMessageEntity,
      { consumerName: message.consumerName, messageId: message.messageId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (entity) {
      entity.payloadHash = message.payloadHash;
      entity.receivedAt = new Date(message.receivedAt.getTime());
      entity.processedAt = message.processedAt ?? null;
      return;
    }
    this.em.persist(MessagesMapper.inboxToEntity(message));
  }
}
