import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'event_id', type: 'uuid' })
  eventId!: string;

  @Property({ fieldName: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', length: 128 })
  eventType!: string;

  @Property()
  version!: number;

  @Property({ fieldName: 'correlation_id', length: 255 })
  correlationId!: string;

  @Property({ fieldName: 'causation_id', length: 255, nullable: true })
  causationId!: string | null;

  @Property({ columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property()
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at' })
  nextAttemptAt!: Date;

  @Property({ fieldName: 'last_error', nullable: true, columnType: 'text' })
  lastError!: string | null;

  @Property({ fieldName: 'published_at', nullable: true })
  publishedAt!: Date | null;
}
