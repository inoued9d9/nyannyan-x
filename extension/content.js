(() => {
  'use strict';
  const filter = NyanFilter.create({ root: document, mode: 'live', onEvaluate: async ({ signal, ...payload }) => {
    if (signal.aborted) return { ok: false, sent: false };
    const requestId = crypto.randomUUID();
    const cancel = () => { chrome.runtime.sendMessage({ type: 'NYAN_JEV_CANCEL', requestId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_EVALUATE', requestId, ...payload });
      // Another tab can reserve the last slot, or the user can reset the quota
      // while this reply is in transit. Refresh AFTER the filter handles the
      // rejection, so a fresh positive allowance also releases AUTO_LIMIT pause.
      if (response?.code === 'AUTO_LIMIT' && response.sent === false) setTimeout(() => { void refreshJev(); }, 0);
      return response;
    }
    finally { signal.removeEventListener('abort', cancel); }
  } });
  const apply = enabled => enabled ? filter.start() : filter.stop();
  let statusRequest = 0;
  async function loadTestSettings() {
    const settings = await chrome.storage.local.get({ showTestControls: false, mockMode: false });
    filter.setShowTestControls(settings.showTestControls);
    filter.setMockMode(settings.showTestControls === true && settings.mockMode === true);
  }
  async function refreshJev() {
    const current = ++statusRequest;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_STATUS' });
      if (current === statusRequest) {
        const automatic = filter.getStats().autoJudgeEnabled;
        filter.setAutoRemaining(status?.autoRemaining);
        filter.setJevReady(status?.enabled && status.hasKey && status.hasPermission && status.filterEnabled &&
          (!automatic || status.keyState === 'valid'));
      }
    } catch { if (current === statusRequest) filter.setJevReady(false); }
  }
  async function load() {
    const settings = await chrome.storage.local.get({ enabled: true, mockMode: false, allowReveal: false, scoreThreshold: 25, hideQuotes: false, autoJudgeEnabled: false, showUncertain: false });
    await loadTestSettings(); filter.setAllowReveal(settings.allowReveal);
    filter.setScoreThreshold(settings.scoreThreshold); filter.setHideQuotes(settings.hideQuotes);
    filter.setAutoJudgeEnabled(settings.autoJudgeEnabled); filter.setShowUncertain(settings.showUncertain); apply(settings.enabled); await refreshJev();
  }
  void load().catch(() => filter.stop());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) apply(changes.enabled.newValue !== false);
    if (area === 'local' && (changes.mockMode || changes.showTestControls)) void loadTestSettings().catch(() => filter.setShowTestControls(false));
    if (area === 'local' && changes.allowReveal) filter.setAllowReveal(changes.allowReveal.newValue);
    if (area === 'local' && changes.scoreThreshold) filter.setScoreThreshold(changes.scoreThreshold.newValue);
    if (area === 'local' && changes.hideQuotes) filter.setHideQuotes(changes.hideQuotes.newValue);
    if (area === 'local' && changes.showUncertain) filter.setShowUncertain(changes.showUncertain.newValue);
    if (area === 'local' && changes.autoJudgeEnabled) {
      filter.setJevReady(false); filter.setAutoJudgeEnabled(changes.autoJudgeEnabled.newValue); void refreshJev();
    }
    if (area === 'local' && (changes.jevEnabled || changes.jevConfigRevision || changes.enabled || changes.autoSessionLimit)) void refreshJev();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'NYAN_STATUS') respond(filter.getStats());
    if (message?.type === 'NYAN_RESET_TESTS') { filter.resetTests(); respond({ ok: true }); }
  });
  window.addEventListener('pagehide', () => filter.stop());
  window.addEventListener('focus', () => { void refreshJev(); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) void load().catch(() => filter.stop());
  });
})();
