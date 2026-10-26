import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';
let client: Client;

describe('migration structure', () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  test('records the migration as applied', async () => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM mikro_orm_migrations
       WHERE name = 'Migration20261026000000'`,
    );

    expect(result.rows[0]?.count).toBe('1');
  });

  test('creates every required table', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')
       ORDER BY table_name`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });

  test('creates the critical indexes and ledger trigger', async () => {
    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'wager_transactions_reversal_once',
           'wager_transactions_reference_lookup',
           'outbox_pending_dispatch',
           'inbox_unprocessed'
         )
       ORDER BY indexname`,
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'inbox_unprocessed',
      'outbox_pending_dispatch',
      'wager_transactions_reference_lookup',
      'wager_transactions_reversal_once',
    ]);

    const triggers = await client.query<{ trigger_name: string }>(
      `SELECT trigger_name
       FROM information_schema.triggers
       WHERE event_object_schema = 'public'
         AND event_object_table = 'wallet_ledger_entries'
         AND trigger_name = 'wallet_ledger_entries_immutable'`,
    );

    expect(triggers.rows).toHaveLength(2);
  });

  test('defines database checks for balance and ledger arithmetic', async () => {
    const constraints = await client.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE conrelid IN ('wallets'::regclass, 'wallet_ledger_entries'::regclass)
         AND conname IN (
           'wallets_balance_non_negative',
           'ledger_arithmetic_valid',
           'ledger_wallet_transaction_unique'
         )
       ORDER BY conname`,
    );

    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'ledger_arithmetic_valid',
      'ledger_wallet_transaction_unique',
      'wallets_balance_non_negative',
    ]);
  });
});
