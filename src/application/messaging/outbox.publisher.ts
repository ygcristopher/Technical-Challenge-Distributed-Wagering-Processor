import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { OutboxMessage } from '../../domain/messages.js';
import { UnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import { JsonLogger } from '../../observability/json.logger.js';
import { MetricsRegistry } from '../../observability/metrics.registry.js';

export interface OutboxEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_EVENT_PUBLISHER = 'OUTBOX_EVENT_PUBLISHER';

export interface OutboxPublishBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MILLISECONDS = 1000;

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(OUTBOX_EVENT_PUBLISHER)
    private readonly eventPublisher: OutboxEventPublisher,
    @Optional() private readonly logger?: JsonLogger,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === 'false') {
      return;
    }

    const interval = this.readPositiveInteger(
      process.env.OUTBOX_PUBLISHER_INTERVAL_MS,
      DEFAULT_INTERVAL_MILLISECONDS,
    );
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logError('outbox.publisher.batch_failed', error);
      });
    }, interval);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(
    now = new Date(),
    limit = this.readPositiveInteger(process.env.OUTBOX_PUBLISHER_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  ): Promise<OutboxPublishBatchResult> {
    if (this.stopping || this.running) {
      return { claimed: 0, published: 0, retried: 0 };
    }

    this.running = true;
    const startedAt = performance.now();
    try {
      const result = await this.unitOfWork.execute(async (context) => {
        const messages = await context.outbox.findDue(now, limit);
        let published = 0;
        let retried = 0;

        for (const message of messages) {
          try {
            await this.eventPublisher.publish(message);
            message.markPublished(now);
            await context.outbox.save(message);
            published += 1;
            this.metrics?.increment('outbox_publish_total', 1, { status: 'published' });
          } catch (error: unknown) {
            message.scheduleRetry(now, this.errorMessage(error));
            await context.outbox.save(message);
            retried += 1;
            this.metrics?.increment('outbox_publish_total', 1, { status: 'retry' });
            this.metrics?.increment('wager_retries_total', 1, { component: 'outbox' });
          }
        }

        const oldestOccurredAt = messages.reduce<number | undefined>((oldest, message) => {
          const occurredAt = message.occurredAt.getTime();
          return oldest === undefined ? occurredAt : Math.min(oldest, occurredAt);
        }, undefined);
        if (oldestOccurredAt !== undefined) {
          this.metrics?.setGauge('outbox_lag_seconds', Math.max(0, now.getTime() - oldestOccurredAt) / 1000);
        }

        return { claimed: messages.length, published, retried };
      });
      this.metrics?.increment('outbox_batches_total', 1, { status: 'completed' });
      if (result.claimed > 0) {
        this.logger?.info('outbox.publisher.batch_completed', result);
      }
      return result;
    } finally {
      this.metrics?.observe('outbox_publish_latency_ms', performance.now() - startedAt);
      this.running = false;
    }
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message.slice(0, 2000);
    }
    return String(error).slice(0, 2000);
  }

  private logError(event: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event, error: message }));
  }
}
