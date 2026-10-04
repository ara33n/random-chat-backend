import test from 'node:test';
import assert from 'node:assert/strict';
import { BAN_RESET_MS, nextBanPolicy } from '../moderation/ban-policy.js';

test('moderation bans escalate and reset after thirty days', () => {
  const now = Date.UTC(2026, 9, 4);
  assert.deepEqual(nextBanPolicy(null, now), {
    banLevel: 1, durationMs: 600000, nextDurationMs: 86400000,
    escalationResetAt: new Date(now + BAN_RESET_MS),
  });
  assert.equal(nextBanPolicy({ banLevel: 1, createdAt: new Date(now - 1000) }, now).durationMs, 86400000);
  assert.equal(nextBanPolicy({ banLevel: 2, createdAt: new Date(now - 1000) }, now).durationMs, 604800000);
  assert.equal(nextBanPolicy({ banLevel: 3, createdAt: new Date(now - 1000) }, now).durationMs, 604800000);
  assert.equal(nextBanPolicy({ banLevel: 3, createdAt: new Date(now - BAN_RESET_MS) }, now).durationMs, 600000);
});
