import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case.js';
import { Money } from '../../src/domain/money.js';
import { Wallet } from '../../src/domain/wallet.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import { SqsTransactionConsumer } from '../../src/infrastructure/messaging/sqs-transaction.consumer.js';

describe('SQS transaction consumer', () => {
  let orm: MikroORM;
  let unitOfWork: UnitOfWork;
  let client: SQSClient;
  let queueUrl: string;
  let queueName: string;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    unitOfWork = new UnitOfWork(orm);
    client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    queueName = `wager-transactions-test-${randomUUID()}.fifo`;
    await client.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
    }));
    const queue = await client.send(new GetQueueUrlCommand({
      QueueName: queueName,
    }));
    if (!queue.QueueUrl) {
      throw new Error('Test queue URL was not returned');
    }
    queueUrl = queue.QueueUrl;
  });

  afterAll(async () => {
    client.destroy();
    await orm.close(true);
  });

  test('commits inbox and financial effect before deleting the SQS message', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const messageIdempotencyKey = `sqs-${randomUUID()}`;
    const messageBody = JSON.stringify({
      providerId: 'sqs-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: messageIdempotencyKey,
      walletId,
      playerId,
      roundId: 'sqs-round',
      gameId: 'sqs-game',
      kind: 'WIN',
      amount: '12.34',
      currency: 'BRL',
    });

    await unitOfWork.execute(({ wallets }) => wallets.save(Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.zero('BRL'),
    })));
    const sent = await client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: messageBody,
      MessageGroupId: walletId,
      MessageDeduplicationId: randomUUID(),
    }));
    if (!sent.MessageId) {
      throw new Error('SQS message id was not returned');
    }

    const previousWait = process.env.SQS_CONSUMER_WAIT_SECONDS;
    process.env.SQS_CONSUMER_WAIT_SECONDS = '2';
    try {
      const consumer = new SqsTransactionConsumer(
        unitOfWork,
        new ProcessWagerTransactionUseCase(unitOfWork),
        { queueName },
      );
      const result = await consumer.runOnce();
      const state = await unitOfWork.execute(async (context) => ({
        wallet: await context.wallets.findById(walletId),
        inbox: await context.inbox.find(
          process.env.SQS_CONSUMER_NAME ?? 'wagering-sqs-consumer',
          sent.MessageId!,
        ),
      }));

      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(state.wallet?.balance.toString()).toBe('12.34');
      expect(state.inbox?.isProcessed()).toBe(true);
      await consumer.onModuleDestroy();
    } finally {
      if (previousWait === undefined) delete process.env.SQS_CONSUMER_WAIT_SECONDS;
      else process.env.SQS_CONSUMER_WAIT_SECONDS = previousWait;
    }
  });

  test('leaves a poisonous message for SQS redrive into the DLQ', async () => {
    const suffix = randomUUID();
    const poisonQueueName = `wager-poison-${suffix}.fifo`;
    const dlqName = `wager-poison-dlq-${suffix}.fifo`;
    await client.send(new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '1' },
    }));
    const dlq = await client.send(new GetQueueUrlCommand({ QueueName: dlqName }));
    if (!dlq.QueueUrl) throw new Error('Poison DLQ URL was not returned');
    await client.send(new CreateQueueCommand({
      QueueName: poisonQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: `arn:aws:sqs:${process.env.AWS_REGION ?? 'us-east-1'}:000000000000:${dlqName}`,
          maxReceiveCount: '2',
        }),
      },
    }));
    const poisonQueue = await client.send(new GetQueueUrlCommand({ QueueName: poisonQueueName }));
    if (!poisonQueue.QueueUrl) throw new Error('Poison queue URL was not returned');
    await client.send(new SendMessageCommand({
      QueueUrl: poisonQueue.QueueUrl,
      MessageBody: '{"invalid":true}',
      MessageGroupId: 'poison-group',
      MessageDeduplicationId: randomUUID(),
    }));

    const consumer = new SqsTransactionConsumer(
      unitOfWork,
      new ProcessWagerTransactionUseCase(unitOfWork),
      { queueName: poisonQueueName, waitSeconds: 0, visibilityTimeout: 1 },
    );
    await consumer.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await consumer.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await consumer.runOnce();
    const redriven = await client.send(new ReceiveMessageCommand({
      QueueUrl: dlq.QueueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
    }));

    expect(redriven.Messages?.length ?? 0).toBe(1);
    await consumer.onModuleDestroy();
  });
});
