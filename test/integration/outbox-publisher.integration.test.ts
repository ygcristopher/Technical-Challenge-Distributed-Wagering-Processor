import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { OutboxPublisher, OutboxEventPublisher } from '../../src/application/messaging/outbox.publisher.js';
import { OutboxMessage } from '../../src/domain/messages.js';
import { Money } from '../../src/domain/money.js';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction.js';
import { WagerTransactionProcessed } from '../../src/domain/integration-events.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';

class RecordingPublisher implements OutboxEventPublisher {
  readonly messages: OutboxMessage[] = [];
  failuresRemaining: number;

  constructor(failuresRemaining = 0, private readonly delayMilliseconds = 0, private readonly failureMessageId?: string) {
    this.failuresRemaining = failuresRemaining;
  }

  async publish(message: OutboxMessage): Promise<void> {
    if (this.delayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));
    }
    if (this.failuresRemaining > 0 && (this.failureMessageId === undefined || this.failureMessageId === message.id)) {
      this.failuresRemaining -= 1;
      throw new Error('temporary broker failure');
    }
    this.messages.push(message);
  }
}

describe('transactional outbox publisher', () => {
  let orm: MikroORM;
  let unitOfWork: UnitOfWork;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    unitOfWork = new UnitOfWork(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    await orm.em.getConnection().execute(
      "DELETE FROM outbox_messages WHERE payload->'data'->>'providerId' = 'outbox-test-provider'",
    );
  });

  test('persists retry metadata when the broker fails', async () => {
    const message = createOutboxMessage();
    await unitOfWork.execute(({ outbox }) => outbox.save(message));
    const publisher = new OutboxPublisher(unitOfWork, new RecordingPublisher(1, 0, message.id));

    const result = await publisher.runOnce(new Date('2026-10-27T00:00:00.000Z'));
    const stored = await unitOfWork.execute(({ outbox }) => outbox.findById(message.id));

    expect(result.retried).toBeGreaterThanOrEqual(1);
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toBe('temporary broker failure');
    expect(stored?.publishedAt).toBeUndefined();
    expect(stored?.nextAttemptAt.toISOString()).toBe('2026-10-27T00:00:01.000Z');
  });

  test('two concurrent publishers claim each pending row only once', async () => {
    const first = createOutboxMessage();
    const second = createOutboxMessage();
    await unitOfWork.execute(async ({ outbox }) => {
      await outbox.save(first);
      await outbox.save(second);
    });

    const broker = new RecordingPublisher(0, 50);
    const publisherA = new OutboxPublisher(unitOfWork, broker);
    const publisherB = new OutboxPublisher(unitOfWork, broker);
    const [resultA, resultB] = await Promise.all([
      publisherA.runOnce(new Date('2026-10-27T00:01:00.000Z'), 10),
      publisherB.runOnce(new Date('2026-10-27T00:01:00.000Z'), 10),
    ]);

    expect(resultA.claimed + resultB.claimed).toBeGreaterThanOrEqual(2);
    const publishedIds = broker.messages.map((item) => item.id);
    expect(publishedIds.filter((id) => id === first.id)).toHaveLength(1);
    expect(publishedIds.filter((id) => id === second.id)).toHaveLength(1);
    const stored = await unitOfWork.execute(async ({ outbox }) => ({
      first: await outbox.findById(first.id),
      second: await outbox.findById(second.id),
    }));
    expect(stored.first?.publishedAt).toBeDefined();
    expect(stored.second?.publishedAt).toBeDefined();
  });

  test('publishes an outbox event to the real MiniStack FIFO queue', async () => {
    const message = createOutboxMessage();
    await unitOfWork.execute(({ outbox }) => outbox.save(message));

    const publisher = new OutboxPublisher(unitOfWork, new SqsEventPublisher());
    const result = await publisher.runOnce(new Date('2026-10-27T00:02:00.000Z'));
    const stored = await unitOfWork.execute(({ outbox }) => outbox.findById(message.id));

    expect(result.published).toBe(1);
    expect(stored?.publishedAt).toBeDefined();

    const client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    try {
      const queue = await client.send(new GetQueueUrlCommand({
        QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
      }));
      const received = await client.send(new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
      }));
      const matching = received.Messages?.find((item) => {
        try {
          return JSON.parse(item.Body ?? '{}').eventId === message.eventId;
        } catch {
          return false;
        }
      });

      expect(matching).toBeDefined();
      if (matching?.ReceiptHandle) {
        await client.send(new DeleteMessageCommand({
          QueueUrl: queue.QueueUrl,
          ReceiptHandle: matching.ReceiptHandle,
        }));
      }
    } finally {
      client.destroy();
    }
  });
});

function createOutboxMessage(): OutboxMessage {
  const transaction = WagerTransaction.create({
    id: randomUUID(),
    providerId: 'outbox-test-provider',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: 'e'.repeat(64),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: 'outbox-round',
    gameId: 'outbox-game',
    kind: WagerTransactionKind.Win,
    money: Money.from({ amount: '1.25', currency: 'BRL' }),
  });
  return OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, {
    eventId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date('2026-10-27T00:00:00.000Z'),
  }));
}
