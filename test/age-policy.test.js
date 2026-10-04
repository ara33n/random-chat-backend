import test from 'node:test';
import assert from 'node:assert/strict';
import { asksForAge, declaredUnderage, underageShortAnswer } from '../moderation/age-policy.js';

test('detects explicit under-18 self declarations without matching unrelated ages', () => {
  for (const text of ["I'm 16", 'i am only 17 years old', 'my age is 14', 'age: 12', '15 yrs old']) {
    assert.equal(declaredUnderage(text), true, text);
  }
  for (const text of ['I am 18', 'my brother is 15', 'the event is 17 years old', 'room 16', 'I waited 12 minutes']) {
    assert.equal(declaredUnderage(text), false, text);
  }
});

test('recognizes an age question and a short under-18 reply only as separate contextual signals', () => {
  for (const text of ['age?', 'what is your age?', "what's your age", 'how old are you?'])
    assert.equal(asksForAge(text), true, text);
  assert.equal(asksForAge('The golden age?'), false);
  for (const text of ['17', '17 years old', "I'm 16", '9.'])
    assert.equal(underageShortAnswer(text), true, text);
  for (const text of ['18', '17 days', 'room 17', 'my brother is 17'])
    assert.equal(underageShortAnswer(text), false, text);
});
