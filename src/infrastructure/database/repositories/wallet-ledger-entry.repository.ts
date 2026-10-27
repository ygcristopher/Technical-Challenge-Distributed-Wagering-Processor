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

  async reconcile(walletId: string, currency: string): Promise<{
    ledgerBalance: string;
    debitTotal: string;
    creditTotal: string;
    entryCount: number;
  }> {
    const rows = await this.em.getConnection().execute<Array<{
      ledger_balance: string;
      debit_total: string;
      credit_total: string;
      entry_count: string;
    }>>(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS ledger_balance,
         COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::text AS debit_total,
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::text AS credit_total,
         count(*)::text AS entry_count
       FROM wallet_ledger_entries
       WHERE wallet_id = ? AND currency = ?`,
      [walletId, currency],
    );
    const row = rows[0];
    return {
      ledgerBalance: row?.ledger_balance ?? '0.00',
      debitTotal: row?.debit_total ?? '0.00',
      creditTotal: row?.credit_total ?? '0.00',
      entryCount: Number.parseInt(row?.entry_count ?? '0', 10),
    };
  }

  async save(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(WalletLedgerEntryMapper.toEntity(entry));
  }
}
