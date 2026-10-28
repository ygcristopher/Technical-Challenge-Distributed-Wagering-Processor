import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  ServiceUnavailableException,
  Param,
  Post,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { WalletApplicationService } from '../../application/wallets/wallet.application-service.js';
import { CreateWalletDto, LedgerQueryDto, WalletQueryDto } from './wallet.dto.js';
import { OpaqueCursor } from '../../infrastructure/http/pagination.js';

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletApplicationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateWalletDto) {
    const initialBalance = typeof body.initialBalance === 'string'
      ? { amount: body.initialBalance, currency: body.currency ?? '' }
      : body.initialBalance;
    const result = await this.wallets.create({
      ...body,
      currency: initialBalance.currency,
      initialBalance,
    });
    if (!result.ok) {
      if (result.error === 'CONFLICT') throw new ConflictException('Wallet already exists');
      if (result.error === 'INVALID_INPUT') throw new BadRequestException('Invalid wallet');
      throw new ServiceUnavailableException('Wallet persistence unavailable');
    }
    return serializeWallet(result.value);
  }

  @Get()
  async find(@Query() query: WalletQueryDto) {
    const wallet = await this.wallets.findByPlayerAndCurrency(query.playerId, query.currency);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return serializeWallet(wallet);
  }

  @Get(':walletId')
  async findById(@Param('walletId') walletId: string) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return serializeWallet(wallet);
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: LedgerQueryDto) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    const limit = parseLimit(query.limit);
    const cursor = query.cursor ? OpaqueCursor.decode(query.cursor) : undefined;
    if (query.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const entries = await this.wallets.ledger(walletId, limit, cursor);
    const hasNext = entries.length > limit;
    const page = hasNext ? entries.slice(0, limit) : entries;
    return {
      items: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.amount.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasNext && page.at(-1) ? OpaqueCursor.encode(page.at(-1)!.id) : null,
    };
  }

  @Get(':walletId/reconciliation')
  @Post(':walletId/reconciliation')
  async reconciliation(@Param('walletId') walletId: string) {
    const result = await this.wallets.reconcile(walletId);
    if (!result) throw new NotFoundException('Wallet not found');
    return result;
  }
}

function parseLimit(value: string | undefined): number {
  if (!value) return 50;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new BadRequestException('limit must be between 1 and 100');
  }
  return parsed;
}

function serializeWallet(wallet: import('../../domain/wallet.js').Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}
