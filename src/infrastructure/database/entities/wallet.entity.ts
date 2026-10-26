import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/** Persistence model; the domain Wallet remains independent from MikroORM. */
@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', length: 255 })
  playerId!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({ columnType: 'numeric(20,2)' })
  balance!: string;

  @Property()
  version!: number;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at' })
  updatedAt!: Date;
}
