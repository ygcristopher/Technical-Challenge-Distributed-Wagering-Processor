import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OutboxEventPublisher } from '../../application/messaging/outbox.publisher.js';
import { OutboxMessage } from '../../domain/messages.js';

@Injectable()
export class SqsEventPublisher implements OutboxEventPublisher, OnModuleDestroy {
  private readonly client: SQSClient;
  private queueUrl: string | undefined;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = await this.getQueueUrl();
    await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.eventId,
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: message.eventType },
        eventId: { DataType: 'String', StringValue: message.eventId },
        correlationId: { DataType: 'String', StringValue: message.correlationId },
      },
    }));
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }

  private async getQueueUrl(): Promise<string> {
    if (this.queueUrl !== undefined) {
      return this.queueUrl;
    }

    const result = await this.client.send(new GetQueueUrlCommand({
      QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
    }));
    if (!result.QueueUrl) {
      throw new Error('SQS queue URL was not returned');
    }

    this.queueUrl = result.QueueUrl;
    return result.QueueUrl;
  }
}
