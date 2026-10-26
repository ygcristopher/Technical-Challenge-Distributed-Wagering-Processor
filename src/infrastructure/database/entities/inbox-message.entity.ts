import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: 'consumer_name', length: 255 })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id', length: 255 })
  messageId!: string;

  @Property({ columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
