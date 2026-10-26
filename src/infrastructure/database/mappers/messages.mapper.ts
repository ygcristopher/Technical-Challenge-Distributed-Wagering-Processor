import { InboxMessage, InboxMessageState, OutboxMessage, OutboxMessageState } from '../../../domain/messages.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';

export class MessagesMapper {
  static inboxToDomain(entity: InboxMessageEntity): InboxMessage {
    const state: InboxMessageState = {
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: new Date(entity.receivedAt.getTime()),
      ...(entity.processedAt !== null ? { processedAt: new Date(entity.processedAt.getTime()) } : {}),
    };
    return InboxMessage.rehydrate(state);
  }

  static inboxToEntity(message: InboxMessage): InboxMessageEntity {
    const entity = new InboxMessageEntity();
    entity.consumerName = message.consumerName;
    entity.messageId = message.messageId;
    entity.payloadHash = message.payloadHash;
    entity.receivedAt = new Date(message.receivedAt.getTime());
    entity.processedAt = message.processedAt ?? null;
    return entity;
  }

  static outboxToDomain(entity: OutboxMessageEntity): OutboxMessage {
    const state: OutboxMessageState = {
      id: entity.id,
      eventId: entity.eventId,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      version: entity.version,
      correlationId: entity.correlationId,
      payload: entity.payload,
      occurredAt: new Date(entity.occurredAt.getTime()),
      attempts: entity.attempts,
      nextAttemptAt: new Date(entity.nextAttemptAt.getTime()),
      ...(entity.causationId !== null ? { causationId: entity.causationId } : {}),
      ...(entity.lastError !== null ? { lastError: entity.lastError } : {}),
      ...(entity.publishedAt !== null ? { publishedAt: new Date(entity.publishedAt.getTime()) } : {}),
    };
    return OutboxMessage.rehydrate(state);
  }

  static outboxToEntity(message: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.eventId = message.eventId;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.version = message.version;
    entity.correlationId = message.correlationId;
    entity.causationId = message.causationId ?? null;
    entity.payload = { ...message.payload };
    entity.occurredAt = new Date(message.occurredAt.getTime());
    entity.attempts = message.attempts;
    entity.nextAttemptAt = new Date(message.nextAttemptAt.getTime());
    entity.lastError = message.lastError ?? null;
    entity.publishedAt = message.publishedAt ?? null;
    return entity;
  }
}
