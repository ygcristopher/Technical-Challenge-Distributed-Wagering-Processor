import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';
let client: Client;
let savepointNumber = 0;

async function expectConstraintFailure(query: string, values: readonly unknown[]): Promise<void> {
  const savepoint = `constraint_failure_${savepointNumber++}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  await expect(client.query(query, values)).rejects.toBeDefined();
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

async function insertWallet(balance = '100.00'): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance)
     VALUES ($1, $2, 'BRL', $3)`,
    [id, randomUUID(), balance],
  );
  return id;
}

async function insertTransaction(walletId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const providerId = String(overrides.providerId ?? randomUUID());
  const externalId = String(overrides.externalId ?? randomUUID());
  const idempotencyKey = String(overrides.idempotencyKey ?? randomUUID());
  await client.query(
    `INSERT INTO wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, money_amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'BET', 10.00, 'BRL')`,
    [id, providerId, externalId, idempotencyKey, 'a'.repeat(64), walletId, randomUUID(), 'round-1', 'game-1'],
  );
  return id;
}

describe('schema invariants', () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query('BEGIN');
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  test('rejects a negative wallet balance', async () => {
    await expectConstraintFailure(
      `INSERT INTO wallets (id, player_id, currency, balance)
       VALUES ($1, $2, 'BRL', -0.01)`,
      [randomUUID(), randomUUID()],
    );
  });

  test('rejects invalid wallet currencies', async () => {
    await expectConstraintFailure(
      `INSERT INTO wallets (id, player_id, currency, balance)
       VALUES ($1, $2, 'brl', 0)`,
      [randomUUID(), randomUUID()],
    );

    await expectConstraintFailure(
      `INSERT INTO wallets (id, player_id, currency, balance)
       VALUES ($1, $2, 'BRLL', 0)`,
      [randomUUID(), randomUUID()],
    );
  });

  test('enforces one wallet per player and currency', async () => {
    const playerId = randomUUID();
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, 'BRL', 0)`,
      [randomUUID(), playerId],
    );

    await expectConstraintFailure(
      `INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, 'BRL', 0)`,
      [randomUUID(), playerId],
    );
  });

  test('enforces both persistent idempotency keys', async () => {
    const walletId = await insertWallet();
    await insertTransaction(walletId, { providerId: 'provider-a', externalId: 'external-a', idempotencyKey: 'key-a' });

    await expectConstraintFailure(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency)
       VALUES ('provider-a', 'external-b', 'key-a', $1, $2, $3, 'round-2', 'game-2', 'BET', 10.00, 'BRL')`,
      ['b'.repeat(64), walletId, randomUUID()],
    );

    await expectConstraintFailure(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency)
       VALUES ('provider-a', 'external-a', 'key-b', $1, $2, $3, 'round-2', 'game-2', 'BET', 10.00, 'BRL')`,
      ['b'.repeat(64), walletId, randomUUID()],
    );
  });

  test('rejects invalid transaction kinds, statuses and amounts', async () => {
    const walletId = await insertWallet();
    const values = [randomUUID(), randomUUID(), randomUUID(), 'e'.repeat(64), walletId, randomUUID()];

    await expectConstraintFailure(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6, 'round', 'game', 'UNKNOWN', 10.00, 'BRL')`,
      values,
    );

    await expectConstraintFailure(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'round', 'game', 'BET', 10.00, 'BRL', 'UNKNOWN')`,
      values,
    );

    await expectConstraintFailure(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6, 'round', 'game', 'BET', 0, 'BRL')`,
      values,
    );
  });

  test('rejects unbalanced ledger entries and later mutations', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertTransaction(walletId);
    const ledgerId = randomUUID();

    await expectConstraintFailure(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 95.00)`,
      [ledgerId, walletId, transactionId],
    );

    await client.query(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00)`,
      [ledgerId, walletId, transactionId],
    );

    await expectConstraintFailure(
      `UPDATE wallet_ledger_entries SET amount = 11.00 WHERE id = $1`,
      [ledgerId],
    );

    await expectConstraintFailure(
      `DELETE FROM wallet_ledger_entries WHERE id = $1`,
      [ledgerId],
    );
  });

  test('enforces ledger direction, positive amount and non-negative balances', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertTransaction(walletId);
    const baseValues = [randomUUID(), walletId, transactionId];

    await expectConstraintFailure(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'INVALID', 10.00, 'BRL', 100.00, 90.00)`,
      baseValues,
    );

    await expectConstraintFailure(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 0, 'BRL', 100.00, 100.00)`,
      baseValues,
    );

    await expectConstraintFailure(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', -1.00, -11.00)`,
      baseValues,
    );
  });

  test('enforces one ledger entry per wallet and transaction', async () => {
    const walletId = await insertWallet();
    const transactionId = await insertTransaction(walletId);
    const entryId = randomUUID();

    await client.query(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00)`,
      [entryId, walletId, transactionId],
    );

    await expectConstraintFailure(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00)`,
      [randomUUID(), walletId, transactionId],
    );
  });

  test('prevents a ledger entry from pointing to another wallet', async () => {
    const walletId = await insertWallet();
    const otherWalletId = await insertWallet();
    const transactionId = await insertTransaction(walletId);

    await expectConstraintFailure(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00)`,
      [randomUUID(), otherWalletId, transactionId],
    );
  });

  test('allows only one non-rejected reversal for a reference and kind', async () => {
    const walletId = await insertWallet();
    const referenceId = await insertTransaction(walletId);
    const firstReversalId = randomUUID();

    await client.query(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency,
         reference_external_transaction_id, reference_transaction_id, status)
       VALUES ($1, 'provider-r', $2, $3, $4, $5, $6, 'round-1', 'game-1', 'ROLLBACK', 10.00, 'BRL', $7, $8, 'PROCESSED')`,
      [firstReversalId, randomUUID(), randomUUID(), 'c'.repeat(64), walletId, randomUUID(), 'reference-external', referenceId],
    );

    await expectConstraintFailure(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency,
         reference_external_transaction_id, reference_transaction_id, status)
       VALUES ('provider-r', $1, $2, $3, $4, $5, 'round-1', 'game-1', 'ROLLBACK', 10.00, 'BRL', 'reference-external', $6, 'PROCESSED')`,
      [randomUUID(), randomUUID(), 'd'.repeat(64), walletId, randomUUID(), referenceId],
    );
  });

  test('allows a corrected reversal after a rejected attempt', async () => {
    const walletId = await insertWallet();
    const referenceId = await insertTransaction(walletId);

    await client.query(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency,
         reference_external_transaction_id, reference_transaction_id, status)
       VALUES ('provider-c', $1, $2, $3, $4, $5, 'round-1', 'game-1', 'ROLLBACK', 10.00, 'BRL', 'reference-c', $6, 'REJECTED')`,
      [randomUUID(), randomUUID(), 'f'.repeat(64), walletId, randomUUID(), referenceId],
    );

    await client.query(
      `INSERT INTO wager_transactions
        (provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, currency,
         reference_external_transaction_id, reference_transaction_id, status)
       VALUES ('provider-c', $1, $2, $3, $4, $5, 'round-1', 'game-1', 'ROLLBACK', 10.00, 'BRL', 'reference-c', $6, 'PROCESSED')`,
      [randomUUID(), randomUUID(), 'g'.repeat(64), walletId, randomUUID(), referenceId],
    );
  });

  test('enforces inbox identity by consumer and message', async () => {
    await client.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
       VALUES ('wager-consumer', 'message-1', $1)`,
      ['h'.repeat(64)],
    );

    await expectConstraintFailure(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
       VALUES ('wager-consumer', 'message-1', $1)`,
      ['i'.repeat(64)],
    );

    await client.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
       VALUES ('other-consumer', 'message-1', $1)`,
      ['j'.repeat(64)],
    );
  });

  test('enforces outbox event identity, attempts and version', async () => {
    const eventId = randomUUID();
    const baseValues = [eventId, randomUUID(), 'correlation-1'];

    await client.query(
      `INSERT INTO outbox_messages (event_id, aggregate_id, event_type, correlation_id, payload)
       VALUES ($1, $2, 'WalletBalanceChanged', $3, '{"amount":"10.00"}')`,
      baseValues,
    );

    await expectConstraintFailure(
      `INSERT INTO outbox_messages (event_id, aggregate_id, event_type, correlation_id, payload)
       VALUES ($1, $2, 'WalletBalanceChanged', $3, '{}')`,
      [eventId, randomUUID(), 'correlation-2'],
    );

    await expectConstraintFailure(
      `INSERT INTO outbox_messages
        (event_id, aggregate_id, event_type, correlation_id, payload, attempts)
       VALUES ($1, $2, 'WalletBalanceChanged', $3, '{}', -1)`,
      [randomUUID(), randomUUID(), 'correlation-3'],
    );

    await expectConstraintFailure(
      `INSERT INTO outbox_messages
        (event_id, aggregate_id, event_type, correlation_id, payload, version)
       VALUES ($1, $2, 'WalletBalanceChanged', $3, '{}', 0)`,
      [randomUUID(), randomUUID(), 'correlation-4'],
    );
  });
});
