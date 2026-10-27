import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
}

interface BetResult {
  readonly walletId: string;
  readonly status: number;
}

interface ChildApp {
  readonly port: number;
  readonly process: ReturnType<typeof Bun.spawn>;
}

describe('multi-process concurrency and crash recovery', () => {
  let sqs: SQSClient;

  beforeAll(async () => {
    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  });

  afterAll(async () => {
    sqs.destroy();
  });

  test('three real instances serialize concurrent bets for distinct wallets', async () => {
    const apps = await startApps([3201, 3202, 3203], {
      SQS_CONSUMER_ENABLED: 'false',
      OUTBOX_PUBLISHER_ENABLED: 'false',
    });
    try {
      await Promise.all(apps.map((app) => waitForReady(app.port)));
      const wallets = await Promise.all(apps.map((app) => createWallet(app.port, `multi-player-${randomUUID()}`)));
      const requests = wallets.flatMap((wallet, walletIndex) => [1, 2].map((attempt) => {
        const app = apps[(walletIndex + attempt) % apps.length]!;
        return postBet(app.port, wallet, `multi-${walletIndex}-${attempt}-${randomUUID()}`);
      }));
      const results = await Promise.all(requests);

      for (let index = 0; index < wallets.length; index += 1) {
        const walletResults = results.filter((result) => result.walletId === wallets[index]!.id);
        expect(walletResults.filter((result) => result.status === 201)).toHaveLength(1);
        expect(walletResults.filter((result) => result.status === 422)).toHaveLength(1);
        const reconciliation = await getJson<{ walletBalance: string; ledgerBalance: string; matches: boolean }>(
          apps[index]!.port,
          `/wallets/${wallets[index]!.id}/reconciliation`,
        );
        expect(reconciliation).toMatchObject({ walletBalance: '20.00', ledgerBalance: '20.00', matches: true });
      }
    } finally {
      await stopApps(apps);
    }
  }, 30000);

  test('another real instance completes a message after a worker dies before ack', async () => {
    const suffix = randomUUID();
    const queueName = `wager-crash-${suffix}.fifo`;
    await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '1',
      },
    }));
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!queue.QueueUrl) throw new Error('Crash-test queue URL was not returned');

    const apps = await startApps([3301], {
      SQS_QUEUE_NAME: queueName,
      SQS_CONSUMER_NAME: `crash-consumer-${suffix}`,
      SQS_CONSUMER_ENABLED: 'true',
      SQS_CONSUMER_WAIT_SECONDS: '1',
      SQS_CONSUMER_VISIBILITY_TIMEOUT: '1',
      SQS_CONSUMER_PAUSE_BEFORE_DELETE_MS: '10000',
      OUTBOX_PUBLISHER_ENABLED: 'false',
    });
    const first = apps[0]!;
    let replacement: ChildApp | undefined;
    try {
      await waitForReady(first.port);
      const wallet = await createWallet(first.port, `crash-player-${suffix}`, '0.00');
      const body = {
        providerId: `crash-provider-${suffix}`,
        externalTransactionId: `crash-external-${suffix}`,
        idempotencyKey: `crash-key-${suffix}`,
        walletId: wallet.id,
        playerId: `crash-player-${suffix}`,
        roundId: `crash-round`,
        gameId: `crash-game`,
        kind: 'WIN',
        amount: '7.00',
        currency: 'BRL',
      };
      await sqs.send(new SendMessageCommand({
        QueueUrl: queue.QueueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
      }));

      await waitFor(async () => {
        const reconciliation = await getJson<{ ledgerBalance: string }>(
          first.port,
          `/wallets/${wallet.id}/reconciliation`,
        );
        return reconciliation.ledgerBalance === '7.00';
      }, 15000);
      first.process.kill();
      await first.process.exited;

      replacement = (await startApps([3302], {
        SQS_QUEUE_NAME: queueName,
        SQS_CONSUMER_NAME: `crash-consumer-${suffix}`,
        SQS_CONSUMER_ENABLED: 'true',
        SQS_CONSUMER_WAIT_SECONDS: '1',
        SQS_CONSUMER_VISIBILITY_TIMEOUT: '1',
        OUTBOX_PUBLISHER_ENABLED: 'false',
      }))[0];
      await waitForReady(replacement.port);
      const finalState = await waitFor(async () => {
        const reconciliation = await getJson<{ walletBalance: string; ledgerBalance: string; matches: boolean; entryCount: number }>(
          replacement!.port,
          `/wallets/${wallet.id}/reconciliation`,
        );
        return reconciliation.matches && reconciliation.entryCount === 1 ? reconciliation : undefined;
      }, 15000);
      expect(finalState).toMatchObject({ walletBalance: '7.00', ledgerBalance: '7.00', matches: true, entryCount: 1 });

      const attributes = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      expect(Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0')).toBe(0);
    } finally {
      if (first.process.exitCode === null) {
        first.process.kill();
        await first.process.exited;
      }
      if (replacement && replacement.process.exitCode === null) {
        replacement.process.kill();
        await replacement.process.exited;
      }
    }
  }, 45000);
});

async function startApps(ports: number[], extraEnv: Record<string, string>): Promise<ChildApp[]> {
  return ports.map((port) => ({
    port,
    process: Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        ...extraEnv,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  }));
}

async function stopApps(apps: ChildApp[]): Promise<void> {
  await Promise.all(apps.map(async (app) => {
    if (app.process.exitCode === null) {
      app.process.kill();
    }
    await app.process.exited;
  }));
}

async function waitForReady(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, 15000);
}

async function createWallet(port: number, playerId: string, initialBalance = '100.00'): Promise<WalletResponse> {
  return getJson<WalletResponse>(port, '/wallets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, currency: 'BRL', initialBalance }),
  }, 201);
}

async function postBet(port: number, wallet: WalletResponse, idempotencyKey: string): Promise<BetResult> {
  const response = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      providerId: `multi-provider-${wallet.id}`,
      externalTransactionId: `multi-external-${idempotencyKey}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'multi-round',
      gameId: 'multi-game',
      kind: 'BET',
      amount: '80.00',
      currency: 'BRL',
    }),
  });
  return { walletId: wallet.id, status: response.status };
}

async function getJson<T>(port: number, path: string, init?: RequestInit, expectedStatus = 200): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  if (response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus}, received ${response.status} for ${path}`);
  }
  return await response.json() as T;
}

async function waitFor<T>(read: () => Promise<T | false | undefined>, timeoutMilliseconds: number): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== false && value !== undefined) {
      return value as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}
