import { describe, expect, test } from 'bun:test';
import { hashWagerPayload } from '../../src/application/shared/wager-payload-hash.js';

describe('canonical wager payload hash', () => {
  test('produces the same hash regardless of object property order', () => {
    const first = hashWagerPayload({
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const second = hashWagerPayload({
      money: { currency: 'BRL', amount: '10.00' },
      kind: 'BET',
      gameId: 'game-1',
      roundId: 'round-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      externalTransactionId: 'external-1',
      providerId: 'provider-1',
    });

    expect(first).toBe(second);
  });
});
