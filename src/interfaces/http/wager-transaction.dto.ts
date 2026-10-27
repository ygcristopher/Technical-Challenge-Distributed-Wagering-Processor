import { IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { WagerTransactionKind } from '../../domain/wager-transaction.js';

export class ProcessWagerTransactionDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  providerId!: string;

  @IsString()
  @MinLength(1)
  externalTransactionId!: string;

  @IsString()
  @MinLength(1)
  walletId!: string;

  @IsString()
  @MinLength(1)
  playerId!: string;

  @IsString()
  @MinLength(1)
  roundId!: string;

  @IsString()
  @MinLength(1)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
