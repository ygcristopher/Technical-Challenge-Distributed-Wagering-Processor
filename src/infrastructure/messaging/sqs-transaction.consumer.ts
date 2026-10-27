import { createHash } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InboxMessage } from '../../domain/messages.js';
import {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
} from '../../application/wagering/process-wager-transaction.use-case.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { WagerTransactionKind } from '../../domain/wager-transaction.js';
import { JsonLogger } from '../../observability/json.logger.js';
import { MetricsRegistry } from '../../observability/metrics.registry.js';

export interface SqsConsumeBatchResult {
  readonly received: number;
  readonly processed: number;
  readonly failed: number;
}

export interface SqsTransactionConsumerOptions {
  readonly queueName?: string;
  readonly batchSize?: number;
  readonly waitSeconds?: number;
  readonly visibilityTimeout?: number;
}

@Injectable()
export class SqsTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly client: SQSClient;
  private readonly queueName: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly waitSeconds: number;
  private readonly visibilityTimeout: number;
  private queueUrl: string | undefined;
  private loopPromise: Promise<void> | undefined;
  private receiveController: AbortController | undefined;
  private stopping = false;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Optional() options?: SqsTransactionConsumerOptions,
    @Optional() private readonly logger?: JsonLogger,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {
    const consumerOptions = options ?? {};
    this.queueName = consumerOptions.queueName ?? process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo';
    this.consumerName = process.env.SQS_CONSUMER_NAME ?? 'wagering-sqs-consumer';
    this.batchSize = consumerOptions.batchSize ?? this.readPositiveInteger(process.env.SQS_CONSUMER_BATCH_SIZE, 10);
    this.waitSeconds = consumerOptions.waitSeconds
      ?? this.readBoundedInteger(process.env.SQS_CONSUMER_WAIT_SECONDS, 10, 0, 20);
    this.visibilityTimeout = consumerOptions.visibilityTimeout
      ?? this.readPositiveInteger(process.env.SQS_CONSUMER_VISIBILITY_TIMEOUT, 30);
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  onModuleInit(): void {
    if (process.env.SQS_CONSUMER_ENABLED === 'false') {
      return;
    }
    this.start();
  }

  start(): void {
    if (this.loopPromise !== undefined || this.stopping) {
      return;
    }
    this.loopPromise = this.consumeLoop().finally(() => {
      this.loopPromise = undefined;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
    this.client.destroy();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.receiveController?.abort();
    await this.loopPromise;
  }

  async runOnce(): Promise<SqsConsumeBatchResult> {
    if (this.stopping) {
      return { received: 0, processed: 0, failed: 0 };
    }

    const startedAt = performance.now();
    const messages = await this.receiveMessages();
    this.metrics?.increment('sqs_messages_total', messages.length, { status: 'received' });
    let processed = 0;
    let failed = 0;
    for (const message of messages) {
      try {
        await this.processMessage(message);
        processed += 1;
        this.metrics?.increment('sqs_messages_total', 1, { status: 'processed' });
      } catch (error: unknown) {
        failed += 1;
        this.metrics?.increment('sqs_messages_total', 1, { status: 'failed' });
        this.metrics?.increment('wager_retries_total', 1, { component: 'sqs_consumer' });
        if (this.isDlqCandidate(message)) {
          this.metrics?.increment('sqs_dlq_messages_total', 1, { queue: this.queueName });
        }
        this.logFailure(message, error);
      }
    }
    this.metrics?.observe('sqs_batch_latency_ms', performance.now() - startedAt);
    return { received: messages.length, processed, failed };
  }

  private async consumeLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        if (!this.stopping) {
          this.logError('sqs.consumer.receive_failed', error);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  }

  private async receiveMessages(): Promise<Message[]> {
    const controller = new AbortController();
    this.receiveController = controller;
    try {
      const result = await this.client.send(new ReceiveMessageCommand({
        QueueUrl: await this.getQueueUrl(),
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: this.waitSeconds,
        VisibilityTimeout: this.visibilityTimeout,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }), { abortSignal: controller.signal });
      return result.Messages ?? [];
    } finally {
      if (this.receiveController === controller) {
        this.receiveController = undefined;
      }
    }
  }

  private async processMessage(message: Message): Promise<void> {
    if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined) {
      throw new PermanentMessageError('SQS message is missing id, receipt handle or body');
    }

    const messageId = message.MessageId;
    const input = parseTransactionMessage(message.Body);
    const payloadHash = createHash('sha256').update(message.Body).digest('hex');

    await this.unitOfWork.execute(async (context) => {
      const existing = await context.inbox.find(this.consumerName, messageId, true);
      if (existing?.isProcessed()) {
        return;
      }

      const inbox = existing ?? InboxMessage.receive({
        consumerName: this.consumerName,
        messageId,
        payloadHash,
      });
      await context.inbox.save(inbox);
      const result = await this.useCase.executeInContext(context, input);
      this.assertConsumableResult(result);
      if (result.ok) {
        this.metrics?.increment('wager_transactions_total', 1, {
          kind: result.value.transaction.kind,
          source: 'sqs',
          status: result.value.transaction.status,
        });
        if (result.value.idempotentReplay) {
          this.metrics?.increment('wager_duplicates_total', 1, { source: 'sqs' });
        }
      }
      this.logger?.info('sqs.transaction.completed', {
        messageId,
        transactionId: result.ok ? result.value.transaction.id : undefined,
        status: result.ok ? result.value.transaction.status : result.error.code,
        idempotentReplay: result.ok ? result.value.idempotentReplay : undefined,
      });
      inbox.markProcessed(new Date());
      await context.inbox.save(inbox);
    });

    await this.pauseBeforeDeleteIfConfigured();
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: await this.getQueueUrl(),
      ReceiptHandle: message.ReceiptHandle,
    }));
  }

  private assertConsumableResult(
    result: Awaited<ReturnType<ProcessWagerTransactionUseCase['executeInContext']>>,
  ): void {
    if (result.ok) {
      return;
    }
    throw new RetryableMessageError(`${result.error.code}: ${result.error.message}`);
  }

  private async getQueueUrl(): Promise<string> {
    if (this.queueUrl !== undefined) {
      return this.queueUrl;
    }
    const result = await this.client.send(new GetQueueUrlCommand({
      QueueName: this.queueName,
    }));
    if (!result.QueueUrl) {
      throw new Error('SQS transaction queue URL was not returned');
    }
    this.queueUrl = result.QueueUrl;
    return result.QueueUrl;
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private readBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  private logFailure(message: Message, error: unknown): void {
    this.logError('sqs.consumer.message_failed', error, {
      messageId: message.MessageId,
      receiveCount: message.Attributes?.ApproximateReceiveCount,
    });
  }

  private isDlqCandidate(message: Message): boolean {
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '0', 10);
    const maxReceiveCount = this.readPositiveInteger(process.env.SQS_MAX_RECEIVE_COUNT, 5);
    return receiveCount >= maxReceiveCount;
  }

  private async pauseBeforeDeleteIfConfigured(): Promise<void> {
    const milliseconds = this.readPositiveInteger(process.env.SQS_CONSUMER_PAUSE_BEFORE_DELETE_MS, 0);
    if (milliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  }

  private logError(event: string, error: unknown, extra: Record<string, string | undefined> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event, error: message, ...extra }));
  }
}

class PermanentMessageError extends Error {}

class RetryableMessageError extends Error {}

function parseTransactionMessage(body: string): ProcessWagerTransactionInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new PermanentMessageError('SQS message body is not valid JSON');
  }

  if (!isRecord(parsed)) {
    throw new PermanentMessageError('SQS message body must be an object');
  }

  const kind = requiredString(parsed, 'kind');
  if (!Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind)
    || kind === WagerTransactionKind.Opening) {
    throw new PermanentMessageError('SQS message contains an invalid transaction kind');
  }

  const money = parseMoney(parsed);
  const occurredAt = optionalString(parsed, 'occurredAt');
  const occurredDate = occurredAt === undefined ? undefined : new Date(occurredAt);
  if (occurredDate !== undefined && Number.isNaN(occurredDate.getTime())) {
    throw new PermanentMessageError('SQS message contains an invalid occurredAt');
  }

  const id = optionalString(parsed, 'id');
  const referenceExternalTransactionId = optionalString(parsed, 'referenceExternalTransactionId');
  const correlationId = optionalString(parsed, 'correlationId');
  const causationId = optionalString(parsed, 'causationId');
  return {
    source: 'sqs',
    providerId: requiredString(parsed, 'providerId'),
    externalTransactionId: requiredString(parsed, 'externalTransactionId'),
    idempotencyKey: requiredString(parsed, 'idempotencyKey'),
    payloadHash: createHash('sha256').update(body).digest('hex'),
    walletId: requiredString(parsed, 'walletId'),
    playerId: requiredString(parsed, 'playerId'),
    roundId: requiredString(parsed, 'roundId'),
    gameId: requiredString(parsed, 'gameId'),
    kind: kind as WagerTransactionKind,
    money,
    ...(id !== undefined ? { id } : {}),
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(causationId !== undefined ? { causationId } : {}),
    ...(occurredDate !== undefined ? { occurredAt: occurredDate } : {}),
  };
}

function parseMoney(parsed: Record<string, unknown>): { amount: string; currency: string } {
  const nested = isRecord(parsed.money) ? parsed.money : undefined;
  const amount = nested ? requiredString(nested, 'amount') : requiredString(parsed, 'amount');
  const currency = nested ? requiredString(nested, 'currency') : requiredString(parsed, 'currency');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) {
    throw new PermanentMessageError('SQS message contains invalid money');
  }
  return { amount, currency };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermanentMessageError(`SQS message field ${field} is required`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermanentMessageError(`SQS message field ${field} must be a non-empty string`);
  }
  return value;
}
