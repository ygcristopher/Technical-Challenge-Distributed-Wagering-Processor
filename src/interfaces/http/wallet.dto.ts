import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateWalletDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  playerId!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  initialBalance!: string;
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
