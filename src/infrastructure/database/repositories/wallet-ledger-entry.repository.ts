import { EntityManager } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper.js';

export class WalletLedgerEntryRepository {
  constructor(private readonly em: EntityManager) {}

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const entity = await this.em.findOne(WalletLedgerEntryEntity, { transactionId });
    return entity ? WalletLedgerEntryMapper.toDomain(entity) : undefined;
  }

  async findByWalletId(walletId: string, limit: number, cursor?: string): Promise<WalletLedgerEntry[]> {
    const entries = await this.em.find(
      WalletLedgerEntryEntity,
      cursor ? { walletId, id: { $lt: cursor } } : { walletId },
      { orderBy: { id: 'DESC' }, limit },
    );
    return entries.map(WalletLedgerEntryMapper.toDomain);
  }

  async save(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(WalletLedgerEntryMapper.toEntity(entry));
  }
}
