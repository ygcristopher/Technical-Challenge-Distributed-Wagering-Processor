import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import { WalletApplicationService } from '../../application/wallets/wallet.application-service.js';

@Controller()
export class TransactionQueryController {
  constructor(private readonly wallets: WalletApplicationService) {}

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId') transactionId: string) {
    const transaction = await this.wallets.findTransactionById(transactionId);
    if (!transaction) throw new NotFoundException('Transaction not found');
    return serializeTransaction(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.wallets.findTransactionByProviderAndExternalId(providerId, externalTransactionId);
    if (!transaction) throw new NotFoundException('Transaction not found');
    return serializeTransaction(transaction);
  }
}

function serializeTransaction(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    attempts: transaction.attempts,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
