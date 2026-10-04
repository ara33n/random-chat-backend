import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredUnderage } from '../moderation/age-policy.js';

test('detects explicit under-18 self declarations without matching unrelated ages', () => {
  for (const text of ["I'm 16", 'i am only 17 years old', 'my age is 14', 'age: 12', '15 yrs old']) {
    assert.equal(declaredUnderage(text), true, text);
  }
  for (const text of ['I am 18', 'my brother is 15', 'the event is 17 years old', 'room 16', 'I waited 12 minutes']) {
    assert.equal(declaredUnderage(text), false, text);
  }
});
