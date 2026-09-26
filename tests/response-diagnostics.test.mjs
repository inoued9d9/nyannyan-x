import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ AbortSignal });
for (const file of ['jev-core.js', 'jev-client.js']) {
  vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context);
}
const { NyanJevCore: core, NyanJevClient: client } = context;
const payload = () => ({ model: core.MODEL, answers: {
  discomfort: {
    type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }
  }
} });

test('each response validation failure yields only a fixed diagnostic identifier', () => {
  const cases = [
    ['ENVELOPE', () => null],
    ['MODEL', value => ({ ...value, model: 'PRIVATE_RAW' })],
    ['ANSWERS', value => ({ ...value, answers: 'PRIVATE_RAW' })],
    ['QUESTION', value => { delete value.answers.discomfort; return value; }],
    ['SCORE', value => { value.answers.discomfort.score = 'PRIVATE_RAW'; return value; }],
    ['CONFIDENCE', value => { value.answers.discomfort.confidence = 1.1; return value; }],
    ['PROBABILITY_KEYS', value => { delete value.answers.discomfort.probabilities[3]; return value; }],
    ['PROBABILITY_VALUE', value => { value.answers.discomfort.probabilities[3] = 'PRIVATE_RAW'; return value; }],
    ['PROBABILITY_TOTAL', value => { value.answers.discomfort.probabilities[0] = .5; return value; }],
    ['SCORE_MEAN', value => { value.answers.discomfort.score = 2; return value; }]
  ];
  for (const [diagnostic, change] of cases) {
    assert.throws(() => core.parseResponse(change(payload())), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.diagnostic, diagnostic);
      assert.equal(JSON.stringify(error).includes('PRIVATE_RAW'), false);
      assert.equal(error.stack.includes('PRIVATE_RAW'), false);
      return true;
    });
  }
});

test('unknown diagnostic fields and non-response errors cannot echo arbitrary values', () => {
  for (const value of ['PRIVATE_RAW', '__proto__', 'constructor', {}, null, ['MODEL'], 1]) {
    assert.equal(core.responseDiagnostic(value), '');
    assert.equal(new core.JevError('INVALID_RESPONSE', value).diagnostic, undefined);
  }
  assert.equal(new core.JevError('AUTH', 'MODEL').diagnostic, undefined);
  assert.equal(core.responseDiagnostic('CONTEXT'), '');
  assert.equal(core.responseDiagnostic('CATEGORY'), '');
  assert.throws(() => core.classify({}), error => error.diagnostic === 'CACHE');
});

test('transport shape and JSON decoding are distinct from numeric validation failures', async () => {
  for (const [diagnostic, response] of [
    ['HTTP_SHAPE', {}],
    ['JSON_DECODE', { ok: true, status: 200, json: async () => { throw new Error('PRIVATE_RAW'); } }],
    ['ENVELOPE', { ok: true, status: 200, json: async () => null }]
  ]) {
    await assert.rejects(client.evaluate({ text: '架空本文', apiKey: 'fake-test-only', fetchImpl: async () => response }), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.diagnostic, diagnostic);
      assert.equal(JSON.stringify(error).includes('PRIVATE_RAW'), false);
      return true;
    });
  }
});
