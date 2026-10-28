import { IsString, Matches } from 'class-validator';

export class MoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}
