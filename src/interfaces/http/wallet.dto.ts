import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { MoneyDto } from './money.dto.js';

export class CreateWalletDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  playerId!: string;

  @ValidateIf((value: CreateWalletDto) => typeof value.initialBalance === 'string')
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsNotEmpty()
  @ValidateIf((value: CreateWalletDto) => typeof value.initialBalance === 'object')
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto | string;
}

export class WalletQueryDto {
  @IsString()
  @MinLength(1)
  playerId!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class LedgerQueryDto {
  @IsOptional()
  limit?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}
