import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Optional,
  Post,
  Body,
  Res,
} from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case.js';
import { ProcessWagerTransactionDto } from './wager-transaction.dto.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { JsonLogger } from '../../observability/json.logger.js';
import { MetricsRegistry } from '../../observability/metrics.registry.js';

interface HttpResponse {
  status(code: number): HttpResponse;
}

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Optional() private readonly logger?: JsonLogger,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  @Post('transactions')
  @HttpCode(HttpStatus.CREATED)
  async process(
    @Body() body: ProcessWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const startedAt = performance.now();
    try {
      if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
      const payloadHash = createHash('sha256')
        .update(JSON.stringify(body))
        .digest('hex');
      const result = await this.useCase.execute({
        ...body,
        idempotencyKey,
        payloadHash,
        source: 'http',
        money: { amount: body.amount, currency: body.currency },
        ...(correlationId ? { correlationId } : {}),
      });

      if (!result.ok) {
        this.metrics?.increment('http_requests_total', 1, { endpoint: 'wagering_transaction', status: result.error.code });
        if (result.error.code === 'IDEMPOTENCY_CONFLICT') throw new ConflictException(result.error.message);
        if (result.error.code === 'PERSISTENCE_ERROR') {
          throw new HttpException(result.error.message, HttpStatus.SERVICE_UNAVAILABLE);
        }
        throw new BadRequestException(result.error.message);
      }

      const { transaction, ledgerEntry, idempotentReplay } = result.value;
      const responseStatus = idempotentReplay
        ? HttpStatus.OK
        : transaction.status === WagerTransactionStatus.PendingReference
          ? HttpStatus.ACCEPTED
          : transaction.status === WagerTransactionStatus.Rejected
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.CREATED;
      if (responseStatus !== HttpStatus.CREATED) response.status(responseStatus);
      this.metrics?.increment('http_requests_total', 1, {
        endpoint: 'wagering_transaction',
        status: responseStatus,
      });
      this.logger?.info('http.wagering_transaction.completed', {
        correlationId,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        status: responseStatus,
        idempotentReplay,
      });

      return {
        transaction: {
          id: transaction.id,
          externalTransactionId: transaction.externalTransactionId,
          kind: transaction.kind,
          status: transaction.status,
          failureCode: transaction.failureCode ?? null,
          referenceTransactionId: transaction.referenceTransactionId ?? null,
        },
        ledgerEntry: ledgerEntry ? { id: ledgerEntry.id, balanceAfter: ledgerEntry.balanceAfter.toJSON() } : null,
        idempotentReplay,
      };
    } finally {
      this.metrics?.observe('http_wagering_transaction_latency_ms', performance.now() - startedAt);
    }
  }
}
