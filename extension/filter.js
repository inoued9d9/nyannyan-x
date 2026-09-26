(() => {
  'use strict';
  function create({ root, mode = 'live', getPath = () => location.pathname + location.search,
    onChange = () => {}, onEvaluate, confirmSend = message => globalThis.confirm(message) }) {
    if (!root) throw new Error('A scoped root is required');
    const document = root.ownerDocument || root;
    const records = new Map();
    let active = false, observer, timer, scheduled = false, lastPath, mockMode = false, jevReady = false;
    let autoJudgeEnabled = false, autoTimer, autoBusy = 0, autoNextAt = 0, autoRemaining = 200, showUncertain = false, autoPausedCode = '';
    const autoCache = new Map();
    const inFlight = new Set();
    const errors = Object.freeze({ AUTH: '認証エラー・キーを再確認', RATE_LIMIT: 'API利用上限・時間をおいて再開',
      TIMEOUT: '応答タイムアウト', NETWORK: '通信に失敗', INVALID_RESPONSE: '応答の検証で停止・設定を確認',
      API_ERROR: 'API側のエラー', BUSY: '他のタブの判定待ち', AUTO_LIMIT: 'このセッションの上限',
      NOT_READY: 'API設定を確認', CANCELLED: '取消・送信状況不明', UNKNOWN: '判定に失敗' });
    const errorLabel = code => errors[code] || errors.UNKNOWN;
    let allowReveal = false, hideQuotes = false, showTestControls = mode === 'demo', scoreThreshold = 25, sent = 0, stats = emptyStats();
    function emptyStats() { return { masked: 0, restricted: 0, unknown: 0, public: 0, candidate: 0, excluded: 0, revealed: 0, evaluated: 0, sent }; }
    function invalidate(record) {
      record.pending?.controller.abort(); record.pending = null; record.result = null; record.error = '';
      record.snapshot = null; record.manualTest = false; record.revealed = false; record.errorCode = '';
      record.autoAttempted = false; record.autoNotBefore = Date.now() + 350;
      record.post.removeAttribute('data-nyan-screened');
    }
    function remove(record) {
      invalidate(record); record.post.removeAttribute('data-nyan-masked'); record.post.removeAttribute('data-nyan-holding'); record.post.removeAttribute('data-nyan-attached'); record.ui?.remove(); records.delete(record.post);
    }
    function restoreAll() { for (const record of [...records.values()]) remove(record); }
    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    function button(text, action, disabled = false) {
      const node = element('button', '', text); node.type = 'button'; node.disabled = disabled;
      node.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(event); });
      return node;
    }
    function maySend(record) {
      const info = NyanAdapter.inspect(record.post, mode);
      return active && mode === 'live' && jevReady && typeof onEvaluate === 'function' &&
        NyanPolicy.supportedPath(getPath()) && records.get(record.post) === record &&
        NyanAdapter.isCandidate(record.post, root, mode) && info.decision.visibility === 'candidate' &&
        !(hideQuotes && info.isQuote);
    }
    function stillCurrent(record, operation) {
      if (record.pending !== operation || !maySend(record) || getPath() !== operation.path) return false;
      const info = NyanAdapter.inspect(record.post, mode);
      try { return info.identity === operation.identity && NyanAdapter.snapshot(record.post) === operation.text; }
      catch { return false; }
    }
    async function evaluate(record, event, automatic = false) {
      if ((automatic ? !autoJudgeEnabled : !event?.isTrusted) || record.pending || !maySend(record)) return;
      if (automatic) record.autoAttempted = true;
      let text;
      try { text = NyanAdapter.snapshot(record.post); }
      catch { record.error = '本文の形式・長さが対象外です。送信しません。'; refresh(); return; }
      const identity = NyanAdapter.inspect(record.post, mode).identity;
      const path = getPath();
      const confirmed = automatic || confirmSend('この投稿者自身の本文が現在、誰でも閲覧できる公開投稿であることを自分で確認しましたか？\n鍵・購読者限定・私的情報を含む本文は送信しないでください。引用先のカード本文は送信しません。\n\n投稿者自身の本文（' + text.length + '文字）だけをTypeSafeのJevへ送ります。公開性の確認はXや投稿者の許諾を代替しません。送信済みデータは取り消せません。\n\n公開性と送信する権限を確認して送信する場合のみ「OK」を押してください。');
      if (!confirmed || !maySend(record)) return;
      const operation = { controller: new AbortController(), text, identity, path, automatic };
      record.pending = operation;
      if (!stillCurrent(record, operation)) { invalidate(record); refresh(); return; }
      record.snapshot = text; record.error = ''; record.result = null; record.manualTest = false; record.revealed = false;
      record.errorCode = '';
      const cacheKey = identity + '\n' + text;
      if (automatic) {
        // A cancelled/unknown delivery must not be retried by a status refresh.
        autoCache.set(cacheKey, { result: null, error: '取消・送信状況不明', errorCode: 'CANCELLED' });
        if (autoCache.size > 200) autoCache.delete(autoCache.keys().next().value);
        inFlight.add(cacheKey);
      }
      refresh();
      try {
        const response = await onEvaluate({ text, postId: identity.match(/\/status\/(\d+)/)?.[1],
          publicConfirmed: !automatic, ...(automatic ? { automatic: true, domEligible: true } : {}),
          visibility: 'candidate', isQuote: NyanAdapter.inspect(record.post, mode).isQuote, outerBodyOnly: true, signal: operation.controller.signal });
        if (response?.sent) sent++;
        if (!stillCurrent(record, operation)) return;
        if (response?.ok && typeof response.result?.hide === 'boolean' && Number.isFinite(response.result.score)) record.result = NyanJevCore.classify(response.result, scoreThreshold);
        else {
          record.errorCode = Object.hasOwn(errors, response?.code) ? response.code : 'UNKNOWN';
          record.error = errorLabel(record.errorCode);
          if (automatic && response?.sent === false && response?.code === 'BUSY' && (record.busyRetries || 0) < 3) {
            record.busyRetries = (record.busyRetries || 0) + 1;
            record.autoAttempted = false; record.autoNotBefore = Date.now() + 1500;
            autoCache.delete(cacheKey);
          } else if (automatic) autoPausedCode = record.errorCode;
        }
        if (automatic && record.autoAttempted) rememberAuto(identity, text, record);
      } catch {
        if (stillCurrent(record, operation)) {
          record.errorCode = 'UNKNOWN'; record.error = errorLabel('UNKNOWN');
          if (automatic) autoPausedCode = 'UNKNOWN';
          if (automatic) rememberAuto(identity, text, record);
        }
      } finally {
        if (automatic) inFlight.delete(cacheKey);
        if (record.pending === operation) record.pending = null;
        refresh();
      }
    }
    function rememberAuto(identity, text, record) {
      const key = identity + '\n' + text;
      autoCache.set(key, { result: record.result, error: record.error, errorCode: record.errorCode });
      if (autoCache.size > 200) autoCache.delete(autoCache.keys().next().value);
    }
    function nearViewport(post) {
      const rect = post.getBoundingClientRect();
      const style = document.defaultView.getComputedStyle(post);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        style.display !== 'none' && rect.bottom >= 0 && rect.top <= (document.defaultView?.innerHeight || 800) + 300;
    }
    function scheduleAuto() {
      clearTimeout(autoTimer);
      if (!active || mode !== 'live' || !autoJudgeEnabled || !jevReady || autoRemaining <= 0 || autoBusy >= 2 || autoPausedCode || document.hidden) return;
      autoTimer = setTimeout(pumpAuto, Math.max(40, autoNextAt - Date.now()));
    }
    async function pumpAuto() {
      if (!active || !autoJudgeEnabled || !jevReady || autoRemaining <= 0 || autoBusy >= 2 || autoPausedCode || document.hidden) return;
      let waitForHydration = false;
      const sorted = [...records.values()].sort((a, b) => Math.max(0, a.post.getBoundingClientRect().top) - Math.max(0, b.post.getBoundingClientRect().top));
      for (const record of sorted) {
        if (record.pending || record.result || record.autoAttempted || !nearViewport(record.post) || !maySend(record)) continue;
        if (Date.now() < record.autoNotBefore) { waitForHydration = true; continue; }
        let text;
        try { text = NyanAdapter.snapshot(record.post); }
        catch { record.autoAttempted = true; record.error = '本文の形式・長さが対象外です。送信しません。'; refresh(); continue; }
        const key = record.identity + '\n' + text;
        if (inFlight.has(key)) continue;
        const cached = autoCache.get(key);
        if (cached) {
          record.autoAttempted = true; record.snapshot = text; record.result = cached.result; record.error = cached.error; record.errorCode = cached.errorCode;
          refresh(); continue;
        }
        autoBusy++;
        scheduleAuto();
        try { await evaluate(record, null, true); }
        finally { autoBusy--; autoNextAt = Date.now(); scheduleAuto(); }
        return;
      }
      if (waitForHydration) scheduleAuto();
    }
    function updateCover() {
      const enabled = active && mode === 'live' && autoJudgeEnabled && NyanPolicy.supportedPath(getPath());
      document.documentElement?.toggleAttribute('data-nyan-auto-cover', enabled);
    }
    function judged(record) {
      return record.result ? NyanJevCore.classify(record.result, scoreThreshold) : null;
    }
    function renderKey(record, info, masked, holding) {
      return [info.name, info.identity, info.decision.reason, masked, record.manualTest, mockMode, jevReady,
        Boolean(record.pending), record.error, record.result?.score, record.revealed, allowReveal, showTestControls, scoreThreshold, hideQuotes, info.isQuote, autoJudgeEnabled, holding, autoRemaining === 0, showUncertain, autoPausedCode].join('|');
    }
    function render(record, info, masked, holding) {
      const synthetic = record.manualTest || mockMode;
      const blanketQuote = hideQuotes && info.isQuote;
      const result = judged(record);
      const card = element('section', masked ? 'nyan-card' : holding ? 'nyan-card nyan-waiting' : 'nyan-diagnostic');
      card.dataset.nyanUi = masked ? 'replacement' : holding ? 'waiting' : 'status';
      card.setAttribute('aria-label', masked ? (blanketQuote ? '引用RTの一括非表示・不快感の判定ではありません' : synthetic ? '表示テストによる置換・実判定ではありません' : 'Jevの不快感スコアによる置換') : 'フィルターの判定状態');
      if (masked) {
        const cat = element('span', 'nyan-cat', 'ฅ^•ﻌ•^ฅ'); cat.setAttribute('aria-hidden', 'true'); card.append(cat);
        card.append(element('span', 'nyan-author', 'ねこ'));
        card.append(element('span', 'nyan-message', NyanPolicy.cryFor(info.identity || info.name)));
        const reason = element('span', 'nyan-reason', blanketQuote ? '引用RT · 未判定' : synthetic ? 'テスト' : `Jev ${result.score}`);
        reason.title = blanketQuote ? '引用RTを一律に隠す設定。不快感を判定せず、Jevにも送りません。' : synthetic ? '表示テスト：高い不快感を仮定。実際の判定は未実施' : '読後の不快感の目安。法的な誹謗中傷の判定ではありません。';
        card.append(reason);
        if (allowReveal) {
          const undo = button('原文を表示', () => { record.manualTest = false; record.revealed = true; refresh(); });
          undo.setAttribute('aria-label', '原文に戻す'); card.append(undo);
        }
      } else if (holding) {
        const label = record.pending ? '判定中…' : record.error ? '未判定 · ' + record.error : autoRemaining <= 0 ? '未判定 · このセッションの自動判定上限です' :
          autoPausedCode ? '自動判定を一時停止 · ' + errorLabel(autoPausedCode) : jevReady ? '自動判定待ち…' : '自動判定待ち · APIキーと設定を確認してください';
        card.append(element('span', 'nyan-reason', label));
        card.title = '未判定は不快感が高いという意味ではありません。接続エラー時は設定で確認後、自動判定をOFF→ONで再試行できます。エラー時の原文表示も設定で選べます。';
        if (allowReveal) card.append(button('未判定の原文を表示', () => { record.revealed = true; refresh(); }));
      } else {
        let label = '未判定 · ' + info.decision.reason;
        if (!showTestControls && info.decision.visibility === 'candidate') label = '未判定 · 公開性未確認';
        if (record.pending) label = 'Jev判定中 · 確認した本文1件のみ送信';
        else if (record.error) label = '未判定 · ' + record.error + '（送信済みの場合があります）';
        else if (autoPausedCode && !result) label = '未判定 · 自動判定は一時停止中（' + errorLabel(autoPausedCode) + '）';
        else if (result) label = `Jev判定済 ${result.score}/100 · ${record.revealed ? '原文を表示中' : '読後の不快感'}`;
        const reason = element('span', 'nyan-reason', label);
        reason.title = info.decision.reason + (autoJudgeEnabled ? '。HTMLで制限表示を検出しなかった本文を自動送信します。公開性の証明ではありません。' : '。候補の診断だけでは送信しません。');
        card.append(reason);
        if (info.decision.eligibleForTest) {
          const actions = element('span', 'nyan-actions');
          if (showTestControls) actions.append(button('置換をテスト', () => { record.manualTest = true; record.revealed = false; refresh(); }, Boolean(record.pending)));
          if (mode === 'live' && onEvaluate && jevReady && !blanketQuote && !autoJudgeEnabled) {
            const send = button('公開確認してJev判定', event => { void evaluate(record, event); }, Boolean(record.pending));
            send.dataset.nyanSend = 'true'; actions.append(send);
          }
          if (actions.childElementCount) card.append(actions);
        }
      }
      card.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      record.ui?.remove(); record.ui = card; record.renderKey = renderKey(record, info, masked, holding);
      if (masked || holding) {
        for (const media of record.post.querySelectorAll('video,audio')) media.pause();
      }
      if (masked) record.post.setAttribute('data-nyan-masked', 'true');
      else record.post.removeAttribute('data-nyan-masked');
      if (holding) record.post.setAttribute('data-nyan-holding', 'true');
      else record.post.removeAttribute('data-nyan-holding');
      record.post.setAttribute('data-nyan-attached', 'true'); record.post.append(card);
    }
    function refresh() {
      scheduled = false;
      if (!active) return;
      updateCover();
      const path = getPath();
      if (lastPath !== path) { restoreAll(); lastPath = path; }
      stats = emptyStats();
      if (!NyanPolicy.supportedPath(path)) { restoreAll(); onChange({ ...stats }); return; }
      const { posts, excluded } = NyanAdapter.candidates(root, mode);
      const present = new Set(posts);
      for (const record of [...records.values()]) if (!present.has(record.post)) remove(record);
      stats.excluded = excluded;
      for (const post of posts) {
        const info = NyanAdapter.inspect(post, mode);
        stats[info.decision.visibility]++;
        let record = records.get(post);
        if (!record) { record = { post, manualTest: false, revealed: false, ui: null, identity: info.identity }; records.set(post, record); }
        if (record.identity !== info.identity || record.visibility !== info.decision.visibility || record.bodyIsolated !== info.bodyIsolated || record.isQuote !== info.isQuote) {
          invalidate(record); record.identity = info.identity; record.visibility = info.decision.visibility;
          record.bodyIsolated = info.bodyIsolated; record.isQuote = info.isQuote;
        }
        if (record.snapshot) {
          try { if (NyanAdapter.snapshot(post) !== record.snapshot) invalidate(record); }
          catch { invalidate(record); }
        }
        const masked = Boolean(((hideQuotes && info.isQuote) || (info.decision.eligibleForTest && (record.manualTest || mockMode || judged(record)?.hide))) && !record.revealed);
        const holding = Boolean(autoJudgeEnabled && mode === 'live' && info.decision.visibility === 'candidate' &&
          !masked && !record.revealed && !record.result &&
          !(showUncertain && !record.pending && (record.error || autoPausedCode)));
        if (!record.ui?.isConnected || record.renderKey !== renderKey(record, info, masked, holding) || post.hasAttribute('data-nyan-masked') !== masked || post.hasAttribute('data-nyan-holding') !== holding) render(record, info, masked, holding);
        post.setAttribute('data-nyan-screened', 'true');
        if (masked) stats.masked++;
        if (record.revealed) stats.revealed++;
        if (record.result) stats.evaluated++;
      }
      onChange({ ...stats });
      scheduleAuto();
    }
    function ownMutation(mutation) {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target?.closest('[data-nyan-ui]')) return true;
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-nyan-masked') {
        const record = records.get(target);
        if (!record || target.hasAttribute('data-nyan-masked') === (record.ui?.dataset.nyanUi === 'replacement')) return true;
        return false;
      }
      if (Array.from(mutation.removedNodes).some(node => records.get(target)?.ui === node)) return false;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      return mutation.type === 'childList' && changed.length > 0 && changed.every(node => node.nodeType === 1 && node.hasAttribute('data-nyan-ui'));
    }
    function schedule(mutations) {
      const external = mutations.filter(m => !ownMutation(m));
      if (!external.length) return;
      for (const mutation of external) {
        const node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        const record = records.get(node?.closest(NyanAdapter.postSelector));
        // Body edits invalidate results/tests; likes and relative timestamps do not.
        const bodyChanged = node?.closest('[data-testid="tweetText"]') || [...mutation.addedNodes, ...mutation.removedNodes]
          .some(child => child.nodeType === 1 && (child.matches('[data-testid="tweetText"]') || child.querySelector('[data-testid="tweetText"]')));
        if (record && bodyChanged) invalidate(record);
      }
      if (!scheduled) { scheduled = true; queueMicrotask(refresh); }
    }
    function start() {
      if (active) return;
      active = true; refresh();
      observer = new MutationObserver(schedule);
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['data-testid', 'aria-label', 'aria-hidden', 'hidden', 'style', 'class', 'title', 'alt', 'href', 'role', 'contenteditable', 'data-nyan-fixture-visibility', 'data-nyan-excluded', 'data-nyan-masked'] });
      timer = setInterval(() => { if (getPath() !== lastPath) refresh(); }, 250);
      document.addEventListener('scroll', scheduleAuto, true);
      document.addEventListener('visibilitychange', scheduleAuto);
    }
    function stop() {
      active = false; observer?.disconnect(); clearInterval(timer); clearTimeout(autoTimer); restoreAll(); autoCache.clear(); updateCover();
      document.removeEventListener('scroll', scheduleAuto, true); document.removeEventListener('visibilitychange', scheduleAuto);
      stats = emptyStats(); onChange({ ...stats });
    }
    function resetTests() { for (const record of records.values()) { record.manualTest = false; if (!record.result) record.revealed = true; } refresh(); }
    function setMockMode(enabled) { mockMode = Boolean(enabled); for (const record of records.values()) { record.manualTest = false; record.revealed = false; } refresh(); }
    function setJevReady(value) {
      jevReady = value === true;
      if (!jevReady) for (const record of records.values()) if (record.pending) invalidate(record);
      refresh();
    }
    function setAllowReveal(value) {
      allowReveal = value === true;
      if (!allowReveal) for (const record of records.values()) record.revealed = false;
      refresh();
    }
    function setScoreThreshold(value) { scoreThreshold = NyanJevCore.normalizeThreshold(value); refresh(); }
    function setShowUncertain(value) { showUncertain = value === true; refresh(); }
    // Quota blocks only new work. Never cancel the request that reserved the last slot.
    function setAutoRemaining(value) {
      autoRemaining = Number.isInteger(value) && value >= 0 && value <= 200 ? value : 0;
      refresh();
    }
    function setAutoJudgeEnabled(value) {
      const next = value === true;
      if (next === autoJudgeEnabled) return;
      autoJudgeEnabled = next; clearTimeout(autoTimer);
      for (const record of records.values()) {
        if (record.pending?.automatic) invalidate(record);
        record.autoAttempted = false; record.revealed = false;
      }
      if (next) { autoCache.clear(); autoPausedCode = ''; }
      updateCover(); refresh();
    }
    function setHideQuotes(value) {
      hideQuotes = value === true;
      for (const record of records.values()) {
        record.revealed = false;
        if (hideQuotes && NyanAdapter.inspect(record.post, mode).isQuote && record.pending) invalidate(record);
      }
      refresh();
    }
    function setShowTestControls(value) {
      showTestControls = value === true;
      if (!showTestControls) { mockMode = false; for (const record of records.values()) record.manualTest = false; }
      refresh();
    }
    return Object.freeze({ start, stop, refresh, resetTests, setMockMode, setJevReady, setAllowReveal, setScoreThreshold, setShowTestControls, setHideQuotes, setAutoJudgeEnabled, setAutoRemaining, setShowUncertain,
      getStats: () => ({ ...stats, mockMode, allowReveal, scoreThreshold, showTestControls, hideQuotes, autoJudgeEnabled, autoRemaining, autoPausedCode }) });
  }
  globalThis.NyanFilter = Object.freeze({ create });
})();
