'use strict';
importScripts('policy.js', 'jev-core.js', 'jev-client.js');

const API_ORIGIN = 'https://api.typesafe.ai/*';
const SAMPLE = 'この説明は根拠が不足していると思います。参考資料を教えてください。';
const FAILURE_CODES = Object.freeze(['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'INVALID_RESPONSE', 'API_ERROR', 'UNKNOWN']);
const pending = new Map();
const ready = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let transaction = Promise.resolve(), credentialEpoch = 0, credentialIntent = 0, sampleSequence = 0, revision = 0;
let verificationDirty = false;

// Serialize credential writes, quota changes/resets and reservations, never network requests.
// storage.session survives a service-worker restart but not a browser session.
function exclusive(action) {
  const next = transaction.then(action);
  transaction = next.catch(() => {});
  return next;
}
function notifyRevision() {
  revision = Math.max(Date.now(), revision + 1);
  return chrome.storage.local.set({ jevConfigRevision: revision });
}
function autoUsed(session, limit) {
  if (session.jevAutoSentCount === undefined) return 0;
  const value = session.jevAutoSentCount;
  // Corrupt counters must not reopen the allowance.
  // Counts above a newly lowered limit remain valid; never reset them implicitly.
  return Number.isInteger(value) && value >= 0 && value <= NyanPolicy.AUTO_QUOTA.maxLimit ? value : limit;
}
function keyState(session) {
  if (!session.jevApiKey) return 'missing';
  if (verificationDirty) return 'unchecked';
  const state = session.jevKeyState;
  if (state === 'checking' && ![...pending.values()].some(request => request.verify && !request.controller.signal.aborted && request.epoch === credentialEpoch)) return 'unchecked';
  return ['unchecked', 'checking', 'valid', 'failed'].includes(state) ? state : 'unchecked';
}
function postError(value) {
  if (!value || !FAILURE_CODES.includes(value.code) || !Number.isSafeInteger(value.at) || value.at <= 0 ||
      !Number.isFinite(new Date(value.at).getTime())) return null;
  // Rebuild only fixed codes + timestamp, even if session data was modified.
  return { code: value.code, diagnostic: value.code === 'INVALID_RESPONSE' ? NyanJevCore.responseDiagnostic(value.diagnostic) : '', at: value.at };
}

function isOwnPage(sender, page) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(page);
}
function isXPage(sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === 'https://x.com';
  } catch { return false; }
}
function isTimeline(sender) { return isXPage(sender) && NyanPolicy.supportedPath(new URL(sender.url).pathname); }
async function status() {
  await ready;
  const [session, local, hasPermission] = await Promise.all([
    chrome.storage.session.get(['jevApiKey', 'jevKeyState', 'jevKeyCheckedAt', 'jevAutoSentCount', 'jevLastPostError']),
    chrome.storage.local.get({ jevEnabled: false, enabled: true, autoJudgeEnabled: false, autoSessionLimit: NyanPolicy.AUTO_QUOTA.defaultLimit }),
    chrome.permissions.contains({ origins: [API_ORIGIN] })
  ]);
  const currentKeyState = keyState(session);
  const autoLimit = NyanPolicy.normalizeAutoLimit(local.autoSessionLimit);
  const used = autoUsed(session, autoLimit);
  return { hasKey: Boolean(session.jevApiKey), enabled: local.jevEnabled === true,
    filterEnabled: local.enabled !== false, hasPermission, model: 'jev-1.13.0',
    keyState: currentKeyState, keyCheckedAt: ['valid', 'failed'].includes(currentKeyState) && Number.isFinite(session.jevKeyCheckedAt) ? session.jevKeyCheckedAt : null,
    autoJudgeEnabled: local.autoJudgeEnabled === true, autoLimit, autoUsed: used, autoRemaining: Math.max(0, autoLimit - used),
    lastPostError: postError(session.jevLastPostError) };
}
function abortWhere(predicate) {
  for (const request of pending.values()) if (predicate(request)) request.controller.abort();
}
async function evaluate(message, sender, testMode = '') {
  const sample = testMode === 'fixed' || testMode === 'custom';
  const verify = testMode === 'fixed';
  const automatic = !sample && message.automatic === true;
  const confirmation = automatic
    ? message.domEligible === true && message.publicConfirmed === false
    : message.automatic === undefined && message.publicConfirmed === true;
  if (!sample && (!isTimeline(sender) || !confirmation || message.visibility !== 'candidate' ||
      message.outerBodyOnly !== true || typeof message.isQuote !== 'boolean' || !/^\d{1,30}$/.test(message.postId || '') ||
      !/^[A-Za-z0-9-]{8,80}$/.test(message.requestId || ''))) {
    return { ok: false, sent: false, error: '送信条件を確認できません。' };
  }
  const text = verify ? SAMPLE : message.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 6000) return { ok: false, sent: false, error: '本文の形式または長さが対象外です。' };
  const requestId = sample ? `sample:${++sampleSequence}` : `${sender.tab.id}:${message.requestId}`;
  const active = [...pending.values()].filter(request => !request.controller.signal.aborted);
  if (active.length >= 2 || pending.has(requestId) || (sample && active.some(request => request.sample))) {
    return { ok: false, sent: false, code: 'BUSY', error: '別の判定中です。完了後に再操作してください。' };
  }
  const request = { controller: new AbortController(), tabId: sender.tab?.id, sent: false,
    isQuote: !sample && message.isQuote, automatic, sample, verify, epoch: credentialEpoch };
  pending.set(requestId, request);
  try {
    const prepared = await exclusive(async () => {
      await ready;
      const [session, local, hasPermission] = await Promise.all([
        chrome.storage.session.get(['jevApiKey', 'jevKeyState', 'jevAutoSentCount']),
        chrome.storage.local.get({ enabled: true, jevEnabled: false, autoJudgeEnabled: false, hideQuotes: false, autoSessionLimit: NyanPolicy.AUTO_QUOTA.defaultLimit }),
        chrome.permissions.contains({ origins: [API_ORIGIN] })
      ]);
      if (request.controller.signal.aborted || request.epoch !== credentialEpoch) return { error: '判定を取り消しました。' };
      if (local.hideQuotes && request.isQuote) return { error: '引用RTは一括非表示のため送信しません。' };
      if (!hasPermission || !session.jevApiKey || (!sample && (local.jevEnabled !== true || local.enabled === false))) {
        return { error: 'Jev設定・接続権限・有効状態を確認してください。' };
      }
      if (automatic && (local.autoJudgeEnabled !== true || keyState(session) !== 'valid')) {
        return { error: '自動判定の設定とキーの接続確認を確認してください。' };
      }
      if (automatic) {
        const limit = NyanPolicy.normalizeAutoLimit(local.autoSessionLimit);
        const used = autoUsed(session, limit);
        if (used >= limit) return { code: 'AUTO_LIMIT', error: 'このブラウザセッションの自動判定上限に達しました。' };
        // Reserve before sending. Failed/cancelled attempts are not refunded.
        await chrome.storage.session.set({ jevAutoSentCount: used + 1 });
      }
      if (verify) await chrome.storage.session.set({ jevKeyState: 'checking', jevKeyCheckedAt: null });
      return { apiKey: session.jevApiKey };
    });
    if (prepared.error) return { ok: false, sent: false, code: prepared.code || 'NOT_READY', error: prepared.error };
    if (request.controller.signal.aborted || request.epoch !== credentialEpoch) return { ok: false, sent: false, error: '判定を取り消しました。' };
    // Only text + fixed schema reach the client. No X URLs, handles, cookies or author metadata.
    request.sent = true;
    const result = await NyanJevClient.evaluate({ text, apiKey: prepared.apiKey, signal: request.controller.signal });
    if (request.controller.signal.aborted || request.epoch !== credentialEpoch) return { ok: false, sent: true, error: '判定を取り消しました。' };
    if (verify && !(await finishKeyCheck(request, 'valid'))) return { ok: false, sent: true, error: '判定を取り消しました。' };
    return { ok: true, sent: true, result };
  } catch (error) {
    if (verify && request.sent) await finishKeyCheck(request, 'failed').catch(() => {});
    // Never echo remote bodies, request text, credentials, or arbitrary exception messages.
    const code = request.controller.signal.aborted ? 'CANCELLED' :
      FAILURE_CODES.includes(error?.code) ? error.code : 'UNKNOWN';
    const diagnostic = code === 'INVALID_RESPONSE' ? NyanJevCore.responseDiagnostic(error?.diagnostic) : '';
    if (!sample && request.sent && code !== 'CANCELLED') {
      await exclusive(async () => {
        if (request.controller.signal.aborted || request.epoch !== credentialEpoch) return;
        await chrome.storage.session.set({ jevLastPostError: { code, diagnostic, at: Date.now() } });
      }).catch(() => {});
    }
    return { ok: false, sent: request.sent, code, ...(diagnostic ? { diagnostic } : {}),
      error: request.controller.signal.aborted ? '判定を取り消しました。' : 'Jev判定に失敗しました。設定画面の診断を確認してください。' };
  } finally { pending.delete(requestId); }
}
async function finishKeyCheck(request, state) {
  return exclusive(async () => {
    if (request.controller.signal.aborted || request.epoch !== credentialEpoch) return false;
    if (!(await chrome.permissions.contains({ origins: [API_ORIGIN] }))) return false;
    if (request.controller.signal.aborted || request.epoch !== credentialEpoch) return false;
    await chrome.storage.session.set({ jevKeyState: state, jevKeyCheckedAt: Date.now() });
    return !request.controller.signal.aborted && request.epoch === credentialEpoch;
  });
}
async function handle(message, sender) {
  const options = isOwnPage(sender, 'options.html');
  const allowed = options || isOwnPage(sender, 'popup.html') || isXPage(sender);
  if (!allowed) return { ok: false, sent: false, error: '対象外の画面です。' };
  switch (message?.type) {
    case 'NYAN_JEV_STATUS': return status();
    case 'NYAN_JEV_SET_AUTO_LIMIT': {
      if (!options || !NyanPolicy.validAutoLimit(message.limit)) return { ok: false, sent: false };
      await exclusive(async () => {
        await ready;
        await chrome.storage.local.set({ autoSessionLimit: message.limit });
      });
      return { ok: true };
    }
    case 'NYAN_JEV_RESET_AUTO_COUNT': {
      if (!options) return { ok: false, sent: false };
      await exclusive(async () => {
        await ready;
        // Reservations before this transaction belong to the previous count.
        // Keep their requests running; completion never adds to the count again.
        await chrome.storage.session.set({ jevAutoSentCount: 0 });
      });
      return { ok: true };
    }
    case 'NYAN_JEV_SAVE_KEY': {
      if (!options || typeof message.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(message.apiKey)) return { ok: false };
      const intent = ++credentialIntent;
      abortWhere(() => true);
      const saved = await exclusive(async () => {
        await ready;
        if (!(await chrome.permissions.contains({ origins: [API_ORIGIN] })) || intent !== credentialIntent) return false;
        await chrome.storage.session.set({ jevApiKey: message.apiKey, jevKeyState: 'unchecked', jevKeyCheckedAt: null, jevLastPostError: null });
        return intent === credentialIntent;
      });
      if (!saved || intent !== credentialIntent) return { ok: false, verified: false, sent: false };
      // Saving explicitly includes one fixed-fiction verification, even with Jev OFF.
      // Give that check priority over work admitted while persistence was pending.
      abortWhere(() => true);
      const checked = await evaluate({}, sender, 'fixed');
      return { ok: true, verified: checked.ok === true && intent === credentialIntent, sent: checked.sent === true,
        ...(checked.code ? { code: checked.code } : {}), ...(checked.diagnostic ? { diagnostic: checked.diagnostic } : {}) };
    }
    case 'NYAN_JEV_DELETE_KEY': {
      if (!options) return { ok: false };
      ++credentialIntent;
      abortWhere(() => true);
      await exclusive(async () => {
        await ready;
        await chrome.storage.session.remove(['jevApiKey', 'jevKeyState', 'jevKeyCheckedAt', 'jevLastPostError']);
      });
      return { ok: true };
    }
    case 'NYAN_JEV_TEST_SAMPLE': return options ? evaluate(message, sender, 'fixed') : { ok: false, sent: false };
    case 'NYAN_JEV_TEST_TEXT': return options ? evaluate(message, sender, 'custom') : { ok: false, sent: false };
    case 'NYAN_JEV_EVALUATE': return evaluate(message, sender);
    case 'NYAN_JEV_CANCEL':
      if (isXPage(sender)) pending.get(`${sender.tab.id}:${message.requestId}`)?.controller.abort();
      return { ok: true };
    default: return { ok: false, sent: false };
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('NYAN_JEV_')) return;
  handle(message, sender).then(respond, () => respond({ ok: false, sent: false, error: 'Jev設定を読み込めません。' }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoSessionLimit) void notifyRevision().catch(() => {});
  if (area === 'local' && changes.hideQuotes?.newValue === true) abortWhere(request => request.isQuote);
  if (area === 'local' && changes.autoJudgeEnabled && changes.autoJudgeEnabled.newValue !== true) abortWhere(request => request.automatic);
  if (area === 'local' && ((changes.jevEnabled && changes.jevEnabled.newValue !== true) || changes.enabled?.newValue === false)) abortWhere(request => !request.sample);
  if (area === 'session' && changes.jevApiKey) {
    ++credentialEpoch;
    abortWhere(() => true);
    // Defend against a key-only storage write retaining the previous key's verdict.
    if (!changes.jevKeyState) {
      verificationDirty = true;
      void exclusive(async () => {
        await chrome.storage.session.set({ jevKeyState: 'unchecked', jevKeyCheckedAt: null });
        verificationDirty = false;
      }).catch(() => {});
    }
  }
  if (area === 'session' && changes.jevKeyState && changes.jevKeyState.newValue !== 'valid') abortWhere(request => request.automatic);
  if (area === 'session' && ['jevApiKey', 'jevKeyState', 'jevKeyCheckedAt', 'jevAutoSentCount', 'jevLastPostError'].some(key => changes[key])) {
    // Non-secret revision only; content scripts cannot read storage.session.
    void notifyRevision().catch(() => {});
  }
});
chrome.permissions.onRemoved.addListener(() => {
  ++credentialIntent;
  ++credentialEpoch;
  abortWhere(() => true);
  verificationDirty = true;
  void exclusive(async () => {
    await ready;
    await chrome.storage.session.set({ jevKeyState: 'unchecked', jevKeyCheckedAt: null });
    verificationDirty = false;
  }).catch(() => {});
  void notifyRevision().catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => abortWhere(request => request.tabId === tabId));
