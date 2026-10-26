import { Migration } from '@mikro-orm/migrations';

export class Migration20261026000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id varchar(255) NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(20, 2) NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id varchar(255) NOT NULL,
        external_transaction_id varchar(255) NOT NULL,
        idempotency_key varchar(512) NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id varchar(255) NOT NULL,
        round_id varchar(255) NOT NULL,
        game_id varchar(255) NOT NULL,
        kind varchar(16) NOT NULL,
        money_amount numeric(20, 2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status varchar(32) NOT NULL DEFAULT 'PENDING',
        failure_code varchar(64),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        CONSTRAINT wager_money_positive CHECK (money_amount > 0),
        CONSTRAINT wager_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_status_valid CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT wager_id_wallet_unique UNIQUE (id, wallet_id),
        CONSTRAINT wager_idempotency_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_external_id_unique UNIQUE (provider_id, external_transaction_id)
      );
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_reference_lookup
      ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE reference_external_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_reversal_once
      ON wager_transactions (reference_transaction_id, kind)
      WHERE reference_transaction_id IS NOT NULL
        AND kind IN ('REFUND', 'ROLLBACK')
        AND status <> 'REJECTED';
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction varchar(6) NOT NULL,
        amount numeric(20, 2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(20, 2) NOT NULL,
        balance_after numeric(20, 2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id)
        REFERENCES wager_transactions(id, wallet_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ledger_arithmetic_valid CHECK (
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
          OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
        ),
        CONSTRAINT ledger_wallet_transaction_unique UNIQUE (wallet_id, transaction_id)
      );
    `);

    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable';
      END;
      $$;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(255) NOT NULL,
        message_id varchar(255) NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL,
        aggregate_id uuid NOT NULL,
        event_type varchar(128) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        correlation_id varchar(255) NOT NULL,
        causation_id varchar(255),
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error text,
        published_at timestamptz,
        CONSTRAINT outbox_event_id_unique UNIQUE (event_id),
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_version_positive CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE INDEX outbox_pending_dispatch
      ON outbox_messages (next_attempt_at, occurred_at)
      WHERE published_at IS NULL;
    `);

    this.addSql(`
      CREATE INDEX inbox_unprocessed
      ON inbox_messages (received_at)
      WHERE processed_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS inbox_unprocessed;');
    this.addSql('DROP INDEX IF EXISTS outbox_pending_dispatch;');
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP INDEX IF EXISTS wager_transactions_reversal_once;');
    this.addSql('DROP INDEX IF EXISTS wager_transactions_reference_lookup;');
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP FUNCTION IF EXISTS prevent_ledger_mutation();');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
