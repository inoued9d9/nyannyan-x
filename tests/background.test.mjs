import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const EXTENSION_ID = 'nyan-test-extension';
const TEST_KEY = 'test-secret-key-never-expose';
const EXAMPLE_TEXT = '架空の本文です。根拠を示してください。';
const API_ORIGIN = 'https://api.typesafe.ai/*';
const RESULT = { score: 4, normalized: 4, hide: false, rubric: 'discomfort-v1', uncertain: false, model: 'jev-1.13.0', reason: '読後の不快感' };
const extensionURL = page => `chrome-extension://${EXTENSION_ID}/${page}`;
const OPTIONS = { id: EXTENSION_ID, url: extensionURL('options.html'), frameId: 0 };
const POPUP = { id: EXTENSION_ID, url: extensionURL('popup.html'), frameId: 0 };
const TIMELINE = { id: EXTENSION_ID, url: 'https://x.com/home', frameId: 0, tab: { id: 44 } };

function request(overrides = {}) {
  return { type: 'NYAN_JEV_EVALUATE', requestId: 'request-0001', postId: '123456789',
    text: EXAMPLE_TEXT, visibility: 'candidate', outerBodyOnly: true, isQuote: false, publicConfirmed: true, ...overrides };
}
function autoRequest(overrides = {}) {
  return request({ automatic: true, domEligible: true, publicConfirmed: false, ...overrides });
}
const AUTO_SETTINGS = {
  local: { enabled: true, jevEnabled: true, autoJudgeEnabled: true },
  session: { jevApiKey: TEST_KEY, jevKeyState: 'valid', jevKeyCheckedAt: 12345 }
};
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  const callbacks = [];
  return { addListener(callback) { callbacks.push(callback); }, emit(...args) { for (const callback of callbacks) callback(...args); } };
}

function harness(settings = {}) {
  const stores = {
    session: { ...(settings.session ?? { jevApiKey: TEST_KEY }) },
    local: { ...(settings.local ?? { enabled: true, jevEnabled: true }) }
  };
  const writes = [];
  const accessLevels = [];
  const imports = [];
  const calls = [];
  const waiters = [];
  let permission = settings.permission ?? true;
  let messageListener;
  const changed = event();
  const permissionRemoved = event();
  const tabRemoved = event();
  function area(name) {
    return {
      async get(keys) {
        if (typeof keys === 'string') return Object.hasOwn(stores[name], keys) ? { [keys]: stores[name][keys] } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => Object.hasOwn(stores[name], key)).map(key => [key, stores[name][key]]));
        return { ...keys, ...stores[name] };
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: stores[name][key], newValue: value };
          stores[name][key] = value;
        }
        writes.push({ area: name, action: 'set', values: { ...values } });
        changed.emit(changes, name);
      },
      async remove(keys) {
        const changes = {};
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          changes[key] = { oldValue: stores[name][key] };
          delete stores[name][key];
        }
        writes.push({ area: name, action: 'remove', keys });
        changed.emit(changes, name);
      },
      async setAccessLevel(value) { accessLevels.push({ area: name, ...value }); }
    };
  }
  const chrome = {
    runtime: { id: EXTENSION_ID, getURL: extensionURL, onMessage: { addListener(callback) { messageListener = callback; } } },
    storage: { session: area('session'), local: area('local'), onChanged: changed },
    permissions: { async contains(value) { assert.deepEqual([...value.origins], [API_ORIGIN]); return permission; }, onRemoved: permissionRemoved },
    tabs: { onRemoved: tabRemoved }
  };
  let context;
  context = vm.createContext({ chrome, URL, AbortController, AbortSignal,
    fetch() { throw new Error('Real network access is forbidden in these tests'); },
    importScripts(...files) {
      imports.push(...files);
      for (const file of files) {
        if (file === 'jev-client.js') {
          context.NyanJevClient = {
            async evaluate(input) {
              calls.push(input);
              for (const waiter of waiters.splice(0)) {
                if (calls.length >= waiter.count) waiter.resolve();
                else waiters.push(waiter);
              }
              return settings.evaluate ? settings.evaluate(input, calls.length) : { ...RESULT };
            }
          };
        } else {
          assert.ok(['policy.js', 'jev-core.js'].includes(file), `unexpected import: ${file}`);
          vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context);
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
  return {
    calls, stores, writes, accessLevels, imports, chrome,
    send(message, sender = TIMELINE) {
      return new Promise((resolve, reject) => {
        try {
          const pending = messageListener(message, sender, resolve);
          if (pending !== true) resolve(undefined);
        } catch (error) { reject(error); }
      });
    },
    waitForCalls(count) {
      if (calls.length >= count) return Promise.resolve();
      return new Promise(resolve => waiters.push({ count, resolve }));
    },
    removePermission() { permission = false; permissionRemoved.emit({ origins: [API_ORIGIN] }); },
    removeTab(tabId) { tabRemoved.emit(tabId); }
  };
}

function assertSafeFailure(value, sent = false) {
  assert.equal(value.ok, false);
  assert.equal(value.sent, sent);
  assert.equal(JSON.stringify(value).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(value).includes(EXAMPLE_TEXT), false);
}
function abortableClient(input) {
  return new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(new Error(`private error ${TEST_KEY} ${EXAMPLE_TEXT}`)), { once: true });
  });
}

test('worker protects session storage and status reports booleans without secrets', async () => {
  const app = harness();
  assert.deepEqual(app.imports, ['policy.js', 'jev-core.js', 'jev-client.js']);
  assert.deepEqual(app.accessLevels, [{ area: 'session', accessLevel: 'TRUSTED_CONTEXTS' }]);
  for (const sender of [OPTIONS, POPUP, TIMELINE]) {
    const state = await app.send({ type: 'NYAN_JEV_STATUS' }, sender);
    assert.deepEqual(Object.keys(state).sort(), ['autoJudgeEnabled', 'autoRemaining', 'enabled', 'filterEnabled', 'hasKey', 'hasPermission', 'keyCheckedAt', 'keyState', 'lastPostError', 'model']);
    assert.equal(state.hasKey, true);
    assert.equal(state.enabled, true);
    assert.equal(state.hasPermission, true);
    assert.equal(state.keyState, 'unchecked');
    assert.equal(state.keyCheckedAt, null);
    assert.equal(state.autoJudgeEnabled, false);
    assert.equal(state.autoRemaining, 200);
    assert.equal(state.lastPostError, null);
    assert.equal(JSON.stringify(state).includes(TEST_KEY), false);
  }
  assert.equal(app.calls.length, 0);
});

test('only options can save or delete credentials; keys never enter local storage', async () => {
  const app = harness({ session: {} });
  for (const sender of [POPUP, TIMELINE, { ...OPTIONS, url: extensionURL('demo.html') }]) {
    assert.equal((await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, sender)).ok, false);
    assert.equal((await app.send({ type: 'NYAN_JEV_DELETE_KEY' }, sender)).ok, false);
  }
  assert.equal(app.writes.length, 0);
  const saved = await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS);
  assert.equal(saved.ok, true);
  assert.equal(saved.verified, true);
  assert.equal(saved.sent, true);
  assert.equal(app.stores.session.jevApiKey, TEST_KEY);
  assert.equal(Object.hasOwn(app.stores.local, 'jevApiKey'), false);
  assert.equal(app.stores.session.jevKeyState, 'valid');
  assert.equal(app.calls.length, 1);
  assert.notEqual(app.calls[0].text, EXAMPLE_TEXT);
  assert.equal(app.writes[0].area, 'session');
  assert.equal((await app.send({ type: 'NYAN_JEV_DELETE_KEY' }, OPTIONS)).ok, true);
  assert.equal(Object.hasOwn(app.stores.session, 'jevApiKey'), false);
  assert.ok(app.writes.filter(write => write.area === 'local').every(write => Object.keys(write.values).join() === 'jevConfigRevision'));
});

test('invalid key and missing permission prevent key persistence', async () => {
  const app = harness({ session: {} });
  for (const apiKey of ['', 'short', 'white space', 'line\nfeed', 'a'.repeat(513), 42]) {
    assert.equal((await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey }, OPTIONS)).ok, false);
  }
  assert.equal(app.writes.length, 0);
  const denied = harness({ session: {}, permission: false });
  assert.equal((await denied.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS)).ok, false);
  assert.equal(denied.writes.length, 0);
});

test('foreign senders, DM paths, wrong origins, frames, and missing tab identity cannot send', async () => {
  const app = harness();
  const senders = [
    { ...TIMELINE, id: 'another-extension' },
    { ...TIMELINE, url: 'https://x.com/messages' },
    { ...TIMELINE, url: 'https://x.com/messages/123' },
    { ...TIMELINE, url: 'https://x.com/i/chat' },
    { ...TIMELINE, url: 'https://x.com/explore' },
    { ...TIMELINE, url: 'https://evil.example/home' },
    { ...TIMELINE, url: 'https://x.com.evil.example/home' },
    { ...TIMELINE, url: 'http://x.com/home' },
    { ...TIMELINE, url: 'not a URL' },
    { ...TIMELINE, frameId: 1 },
    { ...TIMELINE, frameId: undefined },
    { ...TIMELINE, tab: undefined },
    { ...TIMELINE, tab: { id: '44' } },
    OPTIONS, POPUP
  ];
  for (const sender of senders) assertSafeFailure(await app.send(request(), sender));
  assert.equal(app.calls.length, 0);
});

test('strict confirmation, visibility, quote, post, and request gates cannot be bypassed', async () => {
  const app = harness();
  for (const overrides of [
    { publicConfirmed: false }, { publicConfirmed: 'true' }, { publicConfirmed: undefined },
    { visibility: 'protected' }, { visibility: 'subscribers' }, { visibility: 'restricted' },
    { visibility: 'unknown' }, { visibility: 'public' }, { visibility: undefined },
    { outerBodyOnly: false }, { outerBodyOnly: 'true' }, { outerBodyOnly: undefined },
    { isQuote: undefined }, { isQuote: 'false' },
    { postId: '' }, { postId: 'x-123' }, { postId: '1'.repeat(31) },
    { requestId: '' }, { requestId: 'short' }, { requestId: 'has space 123' }, { requestId: 'a'.repeat(81) }
  ]) assertSafeFailure(await app.send(request(overrides)));
  assert.equal(app.calls.length, 0);
});

test('disabled Jev, disabled filter, missing key, and missing permission never invoke the client', async () => {
  for (const settings of [
    { local: { enabled: true, jevEnabled: false } },
    { local: { enabled: false, jevEnabled: true } },
    { local: { enabled: true, jevEnabled: 'true' } },
    { local: {} },
    { session: {} },
    { permission: false }
  ]) {
    const app = harness(settings);
    assertSafeFailure(await app.send(request()));
    assert.equal(app.calls.length, 0);
  }
});

test('only explicit eligible requests pass body and key to client without X metadata', async () => {
  const app = harness();
  const message = request({ author: 'not-to-send', handle: '@private', url: 'https://x.com/name/status/123456789', cookies: 'secret-cookie' });
  const result = await app.send(message);
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.result.score, RESULT.score);
  assert.equal(app.calls.length, 1);
  const input = app.calls[0];
  assert.deepEqual(Object.keys(input).sort(), ['apiKey', 'signal', 'text']);
  assert.equal(input.text, EXAMPLE_TEXT);
  assert.equal(input.apiKey, TEST_KEY);
  assert.ok(input.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(result).includes(EXAMPLE_TEXT), false);
  const reply = await app.send(request({ requestId: 'request-0002' }), { ...TIMELINE, url: 'https://x.com/fictional/status/123' });
  assert.equal(reply.ok, true);
  const search = await app.send(request({ requestId: 'request-0003' }), { ...TIMELINE, url: 'https://x.com/search?q=test&f=live' });
  assert.equal(search.ok, true);
});

test('body validation rejects empty, non-string, and overlong text before sending', async () => {
  const app = harness();
  for (const text of ['', ' \n\t', null, 42, {}, '猫'.repeat(6001), '🐈'.repeat(3001)]) {
    assertSafeFailure(await app.send(request({ text })));
  }
  assert.equal(app.calls.length, 0);
  const result = await app.send(request({ text: '猫'.repeat(6000) }));
  assert.equal(result.ok, true);
  assert.equal(app.calls[0].text.length, 6000);
});

test('sample calls are options-only, work with Jev OFF, and verify the key using fixed Japanese fiction', async () => {
  const app = harness({ local: { enabled: false, jevEnabled: false } });
  const message = { type: 'NYAN_JEV_TEST_SAMPLE', text: 'must-never-be-transmitted', author: 'private' };
  for (const sender of [POPUP, TIMELINE]) assertSafeFailure(await app.send(message, sender));
  assert.equal(app.calls.length, 0);
  const result = await app.send(message, OPTIONS);
  assert.equal(result.ok, true);
  assert.equal(app.stores.session.jevKeyState, 'valid');
  assert.equal(typeof app.stores.session.jevKeyCheckedAt, 'number');
  assert.equal(app.calls[0].text, 'この説明は根拠が不足していると思います。参考資料を教えてください。');
  assert.equal(app.calls[0].text.includes('must-never'), false);
  for (const settings of [{ permission: false }, { session: {} }]) {
    const denied = harness(settings);
    assertSafeFailure(await denied.send(message, OPTIONS));
    assert.equal(denied.calls.length, 0);
  }
});

test('post diagnostics persist fixed identifiers only and a sample success does not erase them', async () => {
  const app = harness({ ...AUTO_SETTINGS, evaluate(input, count) {
    if (count === 1) throw Object.assign(new Error(TEST_KEY + EXAMPLE_TEXT), { code: 'INVALID_RESPONSE', diagnostic: 'PROBABILITY_TOTAL', raw: EXAMPLE_TEXT });
    return RESULT;
  } });
  const result = await app.send(autoRequest());
  assertSafeFailure(result, true);
  assert.equal(result.diagnostic, 'PROBABILITY_TOTAL');
  const state = await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS);
  assert.equal(state.keyState, 'valid');
  assert.equal(state.lastPostError.code, 'INVALID_RESPONSE');
  assert.equal(state.lastPostError.diagnostic, 'PROBABILITY_TOTAL');
  assert.deepEqual(Object.keys(state.lastPostError).sort(), ['at', 'code', 'diagnostic']);
  assert.ok(Number.isSafeInteger(state.lastPostError.at));
  await app.send({ type: 'NYAN_JEV_TEST_SAMPLE' }, OPTIONS);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS)).lastPostError.at, state.lastPostError.at);
  assert.equal(JSON.stringify(app.writes).includes(EXAMPLE_TEXT), false);
  await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: 'different-fake-key' }, OPTIONS);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS)).lastPostError, null);
  await app.chrome.storage.session.set({ jevLastPostError: state.lastPostError });
  await app.send({ type: 'NYAN_JEV_DELETE_KEY' }, OPTIONS);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS)).lastPostError, null);
});

test('diagnostics sanitize modified session data and untrusted exception detail', async () => {
  const app = harness({ evaluate() { throw { code: 'INVALID_RESPONSE', diagnostic: EXAMPLE_TEXT, raw: TEST_KEY }; } });
  const result = await app.send(request());
  assertSafeFailure(result, true);
  assert.equal(result.diagnostic, undefined);
  await app.chrome.storage.session.set({ jevLastPostError: { code: 'INVALID_RESPONSE', diagnostic: EXAMPLE_TEXT, at: 12345, raw: TEST_KEY } });
  const state = await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS);
  assert.equal(state.lastPostError.diagnostic, '');
  assert.equal(JSON.stringify(state).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(state).includes(EXAMPLE_TEXT), false);
  await app.chrome.storage.session.set({ jevLastPostError: { code: EXAMPLE_TEXT, at: 12345 } });
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS)).lastPostError, null);
});

test('cancelled stale requests do not record a post failure for a replaced key', async () => {
  const pending = deferred();
  const app = harness({ ...AUTO_SETTINGS, evaluate: () => pending.promise });
  const response = app.send(autoRequest());
  await app.waitForCalls(1);
  await app.chrome.storage.session.set({ jevApiKey: 'replacement-test-key' });
  pending.reject({ code: 'INVALID_RESPONSE', diagnostic: 'MODEL' });
  assert.equal((await response).code, 'CANCELLED');
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS)).lastPostError, null);
});

test('custom text tests are options-only, explicit, bounded and do not change verification or quota', async () => {
  const app = harness({ local: { enabled: false, jevEnabled: false }, session: { jevApiKey: TEST_KEY, jevKeyState: 'valid', jevKeyCheckedAt: 12345, jevAutoSentCount: 200 } });
  const message = { type: 'NYAN_JEV_TEST_TEXT', text: EXAMPLE_TEXT, cookie: 'not-to-send' };
  for (const sender of [TIMELINE, POPUP]) assertSafeFailure(await app.send(message, sender));
  for (const text of ['', ' \n', undefined, {}, '猫'.repeat(6001)]) assertSafeFailure(await app.send({ ...message, text }, OPTIONS));
  assert.equal(app.calls.length, 0);
  const value = await app.send(message, OPTIONS);
  assert.equal(value.ok, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].text, EXAMPLE_TEXT);
  assert.deepEqual(Object.keys(app.calls[0]).sort(), ['apiKey', 'signal', 'text']);
  assert.equal(app.stores.session.jevKeyState, 'valid');
  assert.equal(app.stores.session.jevKeyCheckedAt, 12345);
  assert.equal(app.stores.session.jevAutoSentCount, 200);
  assert.equal(JSON.stringify(app.writes).includes(EXAMPLE_TEXT), false);
  for (const settings of [{ permission: false }, { session: {} }]) {
    const denied = harness(settings);
    assertSafeFailure(await denied.send(message, OPTIONS));
    assert.equal(denied.calls.length, 0);
  }
});

test('a custom test failure does not invalidate the verified key or become a post error', async () => {
  const app = harness({ ...AUTO_SETTINGS, evaluate() { throw { code: 'INVALID_RESPONSE', diagnostic: 'SCORE_MEAN' }; } });
  const value = await app.send({ type: 'NYAN_JEV_TEST_TEXT', text: EXAMPLE_TEXT }, OPTIONS);
  assert.equal(value.diagnostic, 'SCORE_MEAN');
  const state = await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS);
  assert.equal(state.lastPostError, null);
  assert.equal(state.keyState, 'valid');
  assert.equal(state.keyCheckedAt, 12345);
});

test('arbitrary client errors never return raw message, key, text, or stack', async () => {
  const app = harness({ evaluate() { throw new Error(`${TEST_KEY} ${EXAMPLE_TEXT} https://private.example`); } });
  const value = await app.send(request());
  assertSafeFailure(value, true);
  assert.deepEqual(Object.keys(value).sort(), ['code', 'error', 'ok', 'sent']);
  assert.equal(value.code, 'UNKNOWN');
  assert.equal(value.error.includes('private.example'), false);
});

test('only fixed safe API failure codes are returned, never arbitrary error detail', async () => {
  for (const code of ['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'INVALID_RESPONSE', 'API_ERROR', TEST_KEY]) {
    const app = harness({ evaluate() { throw Object.assign(new Error(TEST_KEY), { code }); } });
    const value = await app.send(request());
    assert.equal(value.code, code === TEST_KEY ? 'UNKNOWN' : code);
    assert.equal(JSON.stringify(value).includes(TEST_KEY), false);
  }
});

test('cancel is scoped to the requesting tab and request identifier', async () => {
  const app = harness({ evaluate: abortableClient });
  const running = app.send(request());
  await app.waitForCalls(1);
  await app.send({ type: 'NYAN_JEV_CANCEL', requestId: 'request-0001' }, { ...TIMELINE, tab: { id: 55 } });
  assert.equal(app.calls[0].signal.aborted, false);
  await app.send({ type: 'NYAN_JEV_CANCEL', requestId: 'different-request' });
  assert.equal(app.calls[0].signal.aborted, false);
  await app.send({ type: 'NYAN_JEV_CANCEL', requestId: 'request-0001' }, { ...TIMELINE, url: 'https://x.com/messages' });
  assert.equal(app.calls[0].signal.aborted, true);
  assertSafeFailure(await running, true);
});

test('disabling either setting, deleting key, or replacing key aborts active transmission', async () => {
  for (const change of ['jev', 'filter', 'delete-key', 'replace-key']) {
    const app = harness({ evaluate: (input, count) => count === 1 ? abortableClient(input) : { ...RESULT } });
    const running = app.send(request());
    await app.waitForCalls(1);
    if (change === 'jev') await app.chrome.storage.local.set({ jevEnabled: false });
    if (change === 'filter') await app.chrome.storage.local.set({ enabled: false });
    if (change === 'delete-key') await app.send({ type: 'NYAN_JEV_DELETE_KEY' }, OPTIONS);
    if (change === 'replace-key') await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: 'replacement-test-key' }, OPTIONS);
    assert.equal(app.calls[0].signal.aborted, true, change);
    assertSafeFailure(await running, true);
  }
});

test('permission revocation aborts all calls; closing a tab only aborts that tab', async () => {
  const revoked = harness({ evaluate: abortableClient });
  const revoking = revoked.send(request());
  await revoked.waitForCalls(1);
  revoked.removePermission();
  assertSafeFailure(await revoking, true);

  const app = harness({ evaluate: abortableClient });
  const first = app.send(request());
  const second = app.send(request(), { ...TIMELINE, tab: { id: 55 } });
  await app.waitForCalls(2);
  app.removeTab(44);
  assert.equal(app.calls[0].signal.aborted, true);
  assert.equal(app.calls[1].signal.aborted, false);
  assertSafeFailure(await first, true);
  app.removeTab(55);
  assertSafeFailure(await second, true);
});

test('concurrent requests are capped at two and duplicate request ids cannot send twice', async () => {
  const waits = [deferred(), deferred()];
  const app = harness({ evaluate: (input, count) => waits[count - 1].promise });
  const first = app.send(request());
  await app.waitForCalls(1);
  assertSafeFailure(await app.send(request()));
  const second = app.send(request({ requestId: 'request-0002' }));
  await app.waitForCalls(2);
  assertSafeFailure(await app.send(request({ requestId: 'request-0003' })));
  assert.equal(app.calls.length, 2);
  waits[0].resolve({ ...RESULT });
  waits[1].resolve({ ...RESULT });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test('cancellation after client resolution prevents publishing a stale result', async () => {
  let app;
  app = harness({ async evaluate() {
    await app.chrome.storage.local.set({ jevEnabled: false });
    return { ...RESULT };
  } });
  assertSafeFailure(await app.send(request()), true);
});

test('irrelevant and malformed messages are ignored without throwing', async () => {
  const app = harness();
  for (const message of [undefined, null, {}, { type: 'UNRELATED' }, { type: 123 }, { type: true }, { type: {} }]) {
    assert.equal(await app.send(message), undefined);
  }
  assert.equal(app.calls.length, 0);
});

test('quote blanket blocks quote requests and aborts pending quote work without blocking originals', async () => {
  const app = harness({ local: { enabled: true, jevEnabled: true, hideQuotes: true } });
  assertSafeFailure(await app.send(request({ isQuote: true })));
  assert.equal(app.calls.length, 0);
  assert.equal((await app.send(request())).ok, true);
  const running = harness({ evaluate: abortableClient });
  const work = running.send(request({ isQuote: true }));
  await running.waitForCalls(1);
  await running.chrome.storage.local.set({ hideQuotes: true });
  assertSafeFailure(await work, true);
});

test('automatic requests require an explicit DOM-only contract and never claim public confirmation', async () => {
  const app = harness(AUTO_SETTINGS);
  for (const overrides of [
    { automatic: false }, { automatic: 'true' }, { automatic: undefined },
    { domEligible: false }, { domEligible: 'true' }, { domEligible: undefined },
    { publicConfirmed: true }, { publicConfirmed: undefined },
    { visibility: 'unknown' }, { visibility: 'restricted' }, { visibility: 'public' },
    { outerBodyOnly: false }, { isQuote: undefined }
  ]) assertSafeFailure(await app.send(autoRequest(overrides)));
  assert.equal(app.calls.length, 0);
  const result = await app.send(autoRequest());
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(app.calls.length, 1);
  assert.deepEqual(Object.keys(app.calls[0]).sort(), ['apiKey', 'signal', 'text']);
  const state = await app.send({ type: 'NYAN_JEV_STATUS' });
  assert.equal(state.keyState, 'valid');
  assert.equal(state.keyCheckedAt, 12345);
  assert.equal(state.autoJudgeEnabled, true);
  assert.equal(state.autoRemaining, 199);
});

test('automatic mode requires master, filter, auto opt-in, verified key, permission, and an allowed path', async () => {
  const settings = [
    { local: { ...AUTO_SETTINGS.local, jevEnabled: false } },
    { local: { ...AUTO_SETTINGS.local, enabled: false } },
    ...[undefined, false, 'true'].map(autoJudgeEnabled => ({ local: { ...AUTO_SETTINGS.local, autoJudgeEnabled } })),
    ...[undefined, 'unchecked', 'checking', 'failed', 'bogus'].map(jevKeyState => ({ session: { ...AUTO_SETTINGS.session, jevKeyState } })),
    { session: {} }, { permission: false }
  ];
  for (const setting of settings) {
    const app = harness({ ...AUTO_SETTINGS, ...setting });
    assertSafeFailure(await app.send(autoRequest()));
    assert.equal(app.calls.length, 0);
    assert.equal(app.stores.session.jevAutoSentCount, undefined);
  }
  const app = harness(AUTO_SETTINGS);
  for (const url of ['https://x.com/messages', 'https://x.com/i/chat', 'https://x.com/explore']) {
    assertSafeFailure(await app.send(autoRequest(), { ...TIMELINE, url }));
  }
  assert.equal(app.calls.length, 0);
});

test('automatic OFF aborts only automatic work; manual requests remain compatible', async () => {
  const app = harness({ ...AUTO_SETTINGS, evaluate: abortableClient });
  const automatic = app.send(autoRequest());
  const manual = app.send(request({ requestId: 'manual-request-0002' }));
  await app.waitForCalls(2);
  await app.chrome.storage.local.set({ autoJudgeEnabled: false });
  assert.equal(app.calls[0].signal.aborted, true);
  assert.equal(app.calls[1].signal.aborted, false);
  assertSafeFailure(await automatic, true);
  await app.send({ type: 'NYAN_JEV_CANCEL', requestId: 'manual-request-0002' });
  assertSafeFailure(await manual, true);
});

test('removing automatic opt-in also aborts automatic work', async () => {
  const app = harness({ ...AUTO_SETTINGS, evaluate: abortableClient });
  const automatic = app.send(autoRequest());
  await app.waitForCalls(1);
  await app.chrome.storage.local.remove('autoJudgeEnabled');
  assertSafeFailure(await automatic, true);
});

test('the 200-attempt automatic allowance is atomic across tabs and survives worker restarts', async () => {
  const app = harness({ ...AUTO_SETTINGS, session: { ...AUTO_SETTINGS.session, jevAutoSentCount: 199 } });
  const results = await Promise.all([
    app.send(autoRequest(), TIMELINE),
    app.send(autoRequest(), { ...TIMELINE, tab: { id: 55 } })
  ]);
  assert.equal(results.filter(value => value.ok).length, 1);
  assert.equal(results.filter(value => !value.ok && !value.sent).length, 1);
  assert.equal(app.calls.length, 1);
  assert.equal(app.stores.session.jevAutoSentCount, 200);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).autoRemaining, 0);
  assertSafeFailure(await app.send(autoRequest({ requestId: 'request-0003' })));
  const restarted = harness({ ...AUTO_SETTINGS, session: { ...app.stores.session } });
  assertSafeFailure(await restarted.send(autoRequest()));
  assert.equal(restarted.calls.length, 0);
  assert.equal((await restarted.send({ type: 'NYAN_JEV_STATUS' })).autoRemaining, 0);
  // The automatic limit does not silently block the explicit manual workflow.
  assert.equal((await restarted.send(request())).ok, true);
});

test('failed and cancelled automatic attempts consume budget; malformed counters fail closed', async () => {
  const failed = harness({ ...AUTO_SETTINGS, evaluate() { throw new Error(TEST_KEY); } });
  assertSafeFailure(await failed.send(autoRequest()), true);
  assert.equal(failed.stores.session.jevAutoSentCount, 1);
  const cancelled = harness({ ...AUTO_SETTINGS, evaluate: abortableClient });
  const work = cancelled.send(autoRequest());
  await cancelled.waitForCalls(1);
  await cancelled.chrome.storage.local.set({ autoJudgeEnabled: false });
  assertSafeFailure(await work, true);
  assert.equal(cancelled.stores.session.jevAutoSentCount, 1);
  for (const jevAutoSentCount of [-1, 201, '0', null, NaN, 0.5]) {
    const app = harness({ ...AUTO_SETTINGS, session: { ...AUTO_SETTINGS.session, jevAutoSentCount } });
    assertSafeFailure(await app.send(autoRequest()));
    assert.equal(app.calls.length, 0);
    assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).autoRemaining, 0);
  }
});

test('quote blanket blocks automatic quote sending without consuming budget', async () => {
  const app = harness({ ...AUTO_SETTINGS, local: { ...AUTO_SETTINGS.local, hideQuotes: true } });
  assertSafeFailure(await app.send(autoRequest({ isQuote: true })));
  assert.equal(app.stores.session.jevAutoSentCount, undefined);
  assert.equal((await app.send(autoRequest())).ok, true);
});

test('saving a key sends exactly one fixed sample with Jev OFF and publishes verification state', async () => {
  const wait = deferred();
  const app = harness({ session: {}, local: { enabled: false, jevEnabled: false }, evaluate: () => wait.promise });
  const work = app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS);
  await app.waitForCalls(1);
  let state = await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS);
  assert.equal(state.keyState, 'checking');
  assert.equal(state.keyCheckedAt, null);
  assert.equal(state.enabled, false);
  assert.equal(app.calls[0].text, 'この説明は根拠が不足していると思います。参考資料を教えてください。');
  await app.chrome.storage.local.set({ jevEnabled: false, enabled: false });
  assert.equal(app.calls[0].signal.aborted, false);
  wait.resolve({ ...RESULT });
  const response = await work;
  assert.deepEqual({ ...response }, { ok: true, verified: true, sent: true });
  assert.equal(app.calls.length, 1);
  state = await app.send({ type: 'NYAN_JEV_STATUS' }, OPTIONS);
  assert.equal(state.keyState, 'valid');
  assert.equal(typeof state.keyCheckedAt, 'number');
  assert.equal(state.autoRemaining, 200);
  assert.equal(JSON.stringify(state).includes(TEST_KEY), false);
  assert.ok(app.writes.filter(write => write.area === 'local').length >= 3);
});

test('verification failure is safe, blocks automatic use, and an explicit recheck can recover', async () => {
  const app = harness({ ...AUTO_SETTINGS, session: {}, evaluate(input, count) {
    if (count === 1) throw new Error(`${TEST_KEY} private remote error`);
    return { ...RESULT };
  } });
  const saved = await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS);
  assert.deepEqual({ ...saved }, { ok: true, verified: false, sent: true, code: 'UNKNOWN' });
  assert.equal(JSON.stringify(saved).includes(TEST_KEY), false);
  let state = await app.send({ type: 'NYAN_JEV_STATUS' });
  assert.equal(state.keyState, 'failed');
  assert.equal(typeof state.keyCheckedAt, 'number');
  assertSafeFailure(await app.send(autoRequest()));
  assert.equal(app.calls.length, 1);
  assert.equal((await app.send({ type: 'NYAN_JEV_TEST_SAMPLE' }, OPTIONS)).ok, true);
  state = await app.send({ type: 'NYAN_JEV_STATUS' });
  assert.equal(state.keyState, 'valid');
  assert.equal((await app.send(autoRequest())).ok, true);
});

test('old verification success cannot overwrite deletion, replacement, or permission revocation', async () => {
  for (const action of ['delete', 'replace', 'revoke']) {
    const old = deferred();
    const app = harness({ session: {}, evaluate: (input, count) => count === 1 ? old.promise : { ...RESULT } });
    const first = app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS);
    await app.waitForCalls(1);
    if (action === 'delete') await app.send({ type: 'NYAN_JEV_DELETE_KEY' }, OPTIONS);
    if (action === 'replace') {
      const replaced = await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: 'replacement-test-key' }, OPTIONS);
      assert.equal(replaced.verified, true);
    }
    if (action === 'revoke') app.removePermission();
    old.resolve({ ...RESULT });
    const result = await first;
    assert.equal(result.verified, false, action);
    assert.equal(result.sent, true, action);
    const state = await app.send({ type: 'NYAN_JEV_STATUS' });
    assert.equal(state.keyState, action === 'replace' ? 'valid' : action === 'delete' ? 'missing' : 'unchecked', action);
    if (action === 'replace') assert.equal(app.stores.session.jevApiKey, 'replacement-test-key');
    if (action === 'delete') assert.equal(state.hasKey, false);
    if (action === 'revoke') assert.equal(state.hasPermission, false);
  }
});

test('replacing or deleting keys does not restore the automatic allowance', async () => {
  const app = harness({ ...AUTO_SETTINGS, session: { ...AUTO_SETTINGS.session, jevAutoSentCount: 17 } });
  const saved = await app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: 'replacement-test-key' }, OPTIONS);
  assert.equal(saved.verified, true);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).autoRemaining, 183);
  await app.send({ type: 'NYAN_JEV_DELETE_KEY' }, OPTIONS);
  const state = await app.send({ type: 'NYAN_JEV_STATUS' });
  assert.equal(state.keyState, 'missing');
  assert.equal(state.keyCheckedAt, null);
  assert.equal(state.autoRemaining, 183);
});

test('a stranded checking state after worker restart is not accepted as a verified key', async () => {
  const app = harness({ ...AUTO_SETTINGS, session: { ...AUTO_SETTINGS.session, jevKeyState: 'checking', jevKeyCheckedAt: null } });
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).keyState, 'unchecked');
  assertSafeFailure(await app.send(autoRequest()));
  assert.equal(app.calls.length, 0);
});

test('a key-only storage replacement invalidates the old verification', async () => {
  const app = harness(AUTO_SETTINGS);
  await app.chrome.storage.session.set({ jevApiKey: 'replacement-test-key' });
  assertSafeFailure(await app.send(autoRequest()));
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).keyState, 'unchecked');
  assert.equal(app.calls.length, 0);
});

test('concurrent credential intents keep only the newest save or deletion', async () => {
  const app = harness({ session: {} });
  const old = app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS);
  const newest = app.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: 'replacement-test-key' }, OPTIONS);
  assert.equal((await old).verified, false);
  assert.equal((await newest).verified, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].apiKey, 'replacement-test-key');
  assert.equal(app.stores.session.jevApiKey, 'replacement-test-key');
  const removing = harness({ session: {} });
  const saving = removing.send({ type: 'NYAN_JEV_SAVE_KEY', apiKey: TEST_KEY }, OPTIONS);
  const deleted = removing.send({ type: 'NYAN_JEV_DELETE_KEY' }, OPTIONS);
  assert.equal((await saving).verified, false);
  assert.equal((await deleted).ok, true);
  assert.equal((await removing.send({ type: 'NYAN_JEV_STATUS' })).keyState, 'missing');
  assert.equal(removing.calls.length, 0);
});

test('explicit rechecking invalidates automatic readiness until the sample succeeds', async () => {
  const check = deferred();
  const app = harness({ ...AUTO_SETTINGS, evaluate: (input, count) => count === 1 ? abortableClient(input) : check.promise });
  const automatic = app.send(autoRequest());
  await app.waitForCalls(1);
  const sample = app.send({ type: 'NYAN_JEV_TEST_SAMPLE' }, OPTIONS);
  await app.waitForCalls(2);
  assertSafeFailure(await automatic, true);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).keyState, 'checking');
  assertSafeFailure(await app.send(autoRequest({ requestId: 'request-0002' })));
  assertSafeFailure(await app.send({ type: 'NYAN_JEV_TEST_SAMPLE' }, OPTIONS));
  assert.equal(app.calls.length, 2);
  check.resolve({ ...RESULT });
  assert.equal((await sample).ok, true);
  assert.equal((await app.send({ type: 'NYAN_JEV_STATUS' })).keyState, 'valid');
});
