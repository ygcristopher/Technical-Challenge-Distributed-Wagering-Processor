import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Body,
  Res,
} from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case.js';
import { ProcessWagerTransactionDto } from './wager-transaction.dto.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';

interface HttpResponse {
  status(code: number): HttpResponse;
}

@Controller('wagering')
export class WageringController {
  constructor(private readonly useCase: ProcessWagerTransactionUseCase) {}

  @Post('transactions')
  @HttpCode(HttpStatus.CREATED)
  async process(
    @Body() body: ProcessWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const result = await this.useCase.execute({
      ...body,
      idempotencyKey,
      payloadHash,
      money: { amount: body.amount, currency: body.currency },
      ...(correlationId ? { correlationId } : {}),
    });

    if (!result.ok) {
      if (result.error.code === 'IDEMPOTENCY_CONFLICT') throw new ConflictException(result.error.message);
      if (result.error.code === 'PERSISTENCE_ERROR') {
        throw new HttpException(result.error.message, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw new BadRequestException(result.error.message);
    }

    const { transaction, ledgerEntry, idempotentReplay } = result.value;
    if (idempotentReplay) response.status(HttpStatus.OK);
    else if (transaction.status === WagerTransactionStatus.PendingReference) response.status(HttpStatus.ACCEPTED);
    else if (transaction.status === WagerTransactionStatus.Rejected) response.status(HttpStatus.UNPROCESSABLE_ENTITY);

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
  }
}
