import { IntegrationEvent, IntegrationEventEnvelope } from './integration-events.js';
import { InvalidTransactionStateError } from './shared/errors.js';

export interface ReceiveInboxProps {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt?: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly receivedAt: Date;
  readonly processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt?.getTime() ?? Date.now()),
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidTransactionStateError(`Inbox message ${this.messageId} is already processed`);
    }
    this._processedAt = new Date(at.getTime());
  }
}

export interface OutboxMessageState {
  readonly id: string;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly version: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastError?: string;
  readonly publishedAt?: Date;
}

const RETRY_BACKOFF_MILLISECONDS = [1000, 5000, 30000, 300000, 900000] as const;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly eventId: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly version: number,
    public readonly correlationId: string,
    public readonly causationId: string | undefined,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _lastError: string | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON() as IntegrationEventEnvelope<unknown>;
    return new OutboxMessage(
      envelope.eventId,
      envelope.eventId,
      envelope.aggregateId,
      envelope.eventType,
      envelope.version,
      envelope.correlationId,
      envelope.causationId,
      Object.freeze({ ...envelope }),
      new Date(envelope.occurredAt),
      0,
      new Date(envelope.occurredAt),
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.eventId,
      state.aggregateId,
      state.eventType,
      state.version,
      state.correlationId,
      state.causationId,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt.getTime()),
      state.attempts,
      new Date(state.nextAttemptAt.getTime()),
      state.lastError,
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt.getTime());
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} is already published`);
    }
    this._publishedAt = new Date(at.getTime());
    this._lastError = undefined;
  }

  scheduleRetry(now: Date, error?: string): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} is already published`);
    }

    this._attempts += 1;
    const backoffIndex = Math.min(this._attempts - 1, RETRY_BACKOFF_MILLISECONDS.length - 1);
    const backoffMilliseconds = RETRY_BACKOFF_MILLISECONDS[backoffIndex] ?? 900000;
    this._nextAttemptAt = new Date(now.getTime() + backoffMilliseconds);
    this._lastError = error;
  }
}
