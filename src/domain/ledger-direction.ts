export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export type LedgerEffect = LedgerDirection | 'NONE';
