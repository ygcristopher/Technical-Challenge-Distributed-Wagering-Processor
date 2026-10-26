import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { InboxMessageRepository } from './repositories/inbox-message.repository.js';
import { OutboxMessageRepository } from './repositories/outbox-message.repository.js';
import { WagerTransactionRepository } from './repositories/wager-transaction.repository.js';
import { WalletLedgerEntryRepository } from './repositories/wallet-ledger-entry.repository.js';
import { WalletRepository } from './repositories/wallet.repository.js';

export class PersistenceContext {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: WalletLedgerEntryRepository;
  readonly inbox: InboxMessageRepository;
  readonly outbox: OutboxMessageRepository;

  constructor(em: EntityManager) {
    this.wallets = new WalletRepository(em);
    this.transactions = new WagerTransactionRepository(em);
    this.ledger = new WalletLedgerEntryRepository(em);
    this.inbox = new InboxMessageRepository(em);
    this.outbox = new OutboxMessageRepository(em);
  }

  async flush(): Promise<void> {
    await this.wallets['em'].flush();
  }
}

export class UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async execute<T>(work: (context: PersistenceContext) => Promise<T>): Promise<T> {
    return this.orm.em.transactional(async (em) => {
      const result = await work(new PersistenceContext(em));
      await em.flush();
      return result;
    });
  }
}
