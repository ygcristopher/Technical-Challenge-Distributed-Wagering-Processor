import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', length: 255 })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', length: 255 })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', length: 512 })
  idempotencyKey!: string;

  @Property({ columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', length: 255 })
  playerId!: string;

  @Property({ fieldName: 'round_id', length: 255 })
  roundId!: string;

  @Property({ fieldName: 'game_id', length: 255 })
  gameId!: string;

  @Property({ length: 16 })
  kind!: string;

  @Property({ fieldName: 'money_amount', columnType: 'numeric(20,2)' })
  moneyAmount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', length: 255, nullable: true })
  referenceExternalTransactionId!: string | null;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @Property({ length: 32 })
  status!: string;

  @Property({ fieldName: 'failure_code', length: 64, nullable: true })
  failureCode!: string | null;

  @Property()
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
