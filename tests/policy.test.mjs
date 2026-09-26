import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../extension/policy.js', import.meta.url), 'utf8'), context);
const { decide, supportedPath } = context.NyanPolicy;

test('automatic quota limits share a strict integer range and default of 200', () => {
  const { AUTO_QUOTA, validAutoLimit, normalizeAutoLimit } = context.NyanPolicy;
  assert.equal(AUTO_QUOTA.defaultLimit, 200);
  for (const value of [1, 200, 201, 10000]) {
    assert.equal(validAutoLimit(value), true);
    assert.equal(normalizeAutoLimit(value), value);
  }
  for (const value of [undefined, null, false, '', '300', 0, -1, 1.5, 10001, NaN, Infinity]) {
    assert.equal(validAutoLimit(value), false);
    assert.equal(normalizeAutoLimit(value), 200);
  }
});

test('only home, search and post conversation routes are supported', () => {
  for (const path of ['/home', '/home/', '/alice/status/123', '/i/web/status/123', '/search', '/search?q=cat&f=live']) assert.equal(supportedPath(path), true, path);
  for (const path of ['/messages', '/messages/123', '/i/chat', '/i/chat/abc', '/settings', '/compose/post', '/alice', '/search/people', '/alice/status/1/photo/1']) assert.equal(supportedPath(path), false, path);
});
test('absence of a private marker never grants live permission', () => {
  const result = decide();
  assert.equal(result.visibility, 'unknown');
  assert.equal(result.mask, false);
  assert.equal(result.eligibleForTest, false);
  assert.equal(result.canSend, false);
});
test('public fixture attribute is never trusted on live X', () => {
  assert.equal(decide({ mode: 'live', fixtureVisibility: 'public' }).visibility, 'unknown');
});
test('restricted fixtures stay original and unjudged, including subscribers', () => {
  for (const fixtureVisibility of ['protected', 'subscribers', 'limited']) {
    const result = decide({ mode: 'demo', fixtureVisibility });
    assert.equal(result.mask, false);
    assert.equal(result.eligibleForTest, false);
    assert.equal(result.visibility, 'restricted');
  }
});
test('uncertain quote cannot piggyback on a public fixture', () => {
  assert.equal(decide({ mode: 'demo', fixtureVisibility: 'public', untrustedQuote: true }).eligibleForTest, false);
});
test('complete live DOM is merely a candidate, never authorized for transmission', () => {
  const result = decide({ mode: 'live', complete: true });
  assert.equal(result.visibility, 'candidate');
  assert.equal(result.canSend, false);
  assert.equal(result.mask, false);
});
test('hidden body content denies even a complete candidate or public fixture', () => {
  for (const mode of ['live', 'demo']) {
    const result = decide({ mode, fixtureVisibility: 'public', complete: true, hiddenBody: true });
    assert.equal(result.visibility, 'unknown');
    assert.equal(result.eligibleForTest, false);
    assert.equal(result.canSend, false);
    assert.equal(result.mask, false);
    assert.match(result.reason, /非表示/);
  }
  const restricted = decide({ complete: true, hiddenBody: true, restrictedKind: 'protected' });
  assert.equal(restricted.visibility, 'restricted');
});
test('cat cries vary but stay stable for the same post', () => {
  const { cryFor, cries } = context.NyanPolicy;
  assert.equal(cryFor('123'), cryFor('123'));
  const values = new Set(Array.from({ length: 20 }, (_, i) => cryFor(String(i))));
  assert.ok(values.size >= 3);
  for (const value of values) assert.ok(cries.includes(value));
});
test('even the public demo fixture cannot send externally in phase 1', () => {
  const result = decide({ mode: 'demo', fixtureVisibility: 'public' });
  assert.equal(result.mask, false);
  assert.equal(result.canSend, false);
});
