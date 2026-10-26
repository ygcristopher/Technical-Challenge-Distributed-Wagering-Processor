import { SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { Client } from 'pg';

export interface DependencyHealth {
  postgres: boolean;
  sqs: boolean;
}

@Injectable()
export class HealthService {
  async checkDependencies(): Promise<DependencyHealth> {
    const [postgres, sqs] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);

    return { postgres, sqs };
  }

  private async checkPostgres(): Promise<boolean> {
    const client = new Client({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async checkSqs(): Promise<boolean> {
    const client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });

    try {
      await client.send(new GetQueueUrlCommand({
        QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
      }));
      return true;
    } catch {
      return false;
    } finally {
      client.destroy();
    }
  }
}
