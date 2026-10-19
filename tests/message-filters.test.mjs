import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCleanupOptions, matchesMessage } from '../src/features/message-filters.js';

const message = id => ({ id, channel_id: 'channel', author: { id: 'self' }, type: 0, content: 'hello' });

test('message range filters keep exclusive exact boundaries across decimal lengths and leading zeros', () => {
  const ids = ['0', '00', '9', '0009', '10', '99', '100', '999999999999999999', '1000000000000000000', '1000000000000000001', '9999999999999999999999'];
  for (const lower of ids) {
    for (const upper of ids) {
      if (BigInt(lower) >= BigInt(upper)) continue;
      const options = normalizeCleanupOptions({ authorId: 'self', minId: lower, maxId: upper });
      for (const id of ids) {
        assert.equal(matchesMessage(message(id), options), BigInt(id) > BigInt(lower) && BigInt(id) < BigInt(upper), `${lower} < ${id} < ${upper}`);
      }
    }
  }
});

test('single-ended ranges preserve author checks and reject malformed message IDs before comparison', () => {
  const boundary = '1000000000000000000';
  for (const side of ['minId', 'maxId']) {
    const options = normalizeCleanupOptions({ authorId: 'self', [side]: boundary });
    for (const id of ['999999999999999999', boundary, '1000000000000000001']) {
      assert.equal(matchesMessage(message(id), options), side === 'minId' ? BigInt(id) > BigInt(boundary) : BigInt(id) < BigInt(boundary));
      assert.equal(matchesMessage({ ...message(id), author: { id: 'other' } }, options), false);
    }
    for (const id of ['', '-1', '1.5', '1e18', 'invalid']) assert.equal(matchesMessage(message(id), options), false);
  }
});
