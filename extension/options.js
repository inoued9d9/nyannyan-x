'use strict';

const apiKeyInput = document.getElementById('api-key');
const keyForm = document.getElementById('key-form');
const enabledInput = document.getElementById('jev-enabled');
const autoJudgeInput = document.getElementById('auto-judge-enabled');
const autoStatus = document.getElementById('auto-status');
const keyStateBadge = document.getElementById('key-state-badge');
const keyCheckedAt = document.getElementById('key-checked-at');
const saveKeyButton = document.getElementById('save-key');
const deleteKeyButton = document.getElementById('delete-key');
const testButton = document.getElementById('test-sample');
const refreshButton = document.getElementById('refresh-status');
const connectionStatus = document.getElementById('connection-status');
const actionStatus = document.getElementById('action-status');
const testResult = document.getElementById('test-result');
const textTestForm = document.getElementById('text-test-form');
const testTextInput = document.getElementById('test-text');
const textTestButton = document.getElementById('test-text-send');
const textTestStatus = document.getElementById('text-test-status');
const textTestDetails = document.getElementById('text-test-details');
let textTestResult = null;
document.getElementById('judge-prompt').textContent = JSON.stringify(NyanJevCore.buildRequest('架空の文章').questions, null, 2);
const allowRevealInput = document.getElementById('allow-reveal');
const hideQuotesInput = document.getElementById('hide-quotes');
const showUncertainInput = document.getElementById('show-uncertain');
const thresholdInput = document.getElementById('score-threshold');
const thresholdRange = document.getElementById('score-threshold-range');
const displayFeedback = document.getElementById('display-feedback');
const permissionOrigin = 'https://api.typesafe.ai/*';
const AUTO_CONSENT_VERSION = 1;
const KEY_STATES = Object.freeze({ missing: '未入力', unchecked: '入力済・未確認', checking: '確認中…',
  valid: '入力済・接続確認済', failed: '入力済・確認失敗' });
const FAILURE_LABELS = Object.freeze({ AUTH: '認証・利用権限エラー', RATE_LIMIT: 'API利用上限', TIMEOUT: '応答タイムアウト',
  NETWORK: '通信エラー', INVALID_RESPONSE: 'API応答形式を確認できません', API_ERROR: 'API側エラー', BUSY: '別の判定中', CANCELLED: '中止されました', UNKNOWN: '判定に失敗しました' });
const failureLabel = (code, diagnostic) => {
  const label = FAILURE_LABELS[code] || '接続・応答を確認できません';
  const safe = code === 'INVALID_RESPONSE' ? NyanJevCore.responseDiagnostic(diagnostic) : '';
  return safe ? `${label}（${NyanJevCore.RESPONSE_DIAGNOSTICS[safe]} / ${safe}）` : label;
};
const postErrorStatus = document.getElementById('post-error-status');
function showPostError(value) {
  const valid = value && Object.hasOwn(FAILURE_LABELS, value.code) && Number.isSafeInteger(value.at) && value.at > 0 && Number.isFinite(new Date(value.at).getTime());
  postErrorStatus.hidden = !valid;
  postErrorStatus.textContent = valid ? `最後の投稿判定エラー: ${failureLabel(value.code, value.diagnostic)}。発生: ${new Date(value.at).toLocaleString('ja-JP')}。接続確認済みでも、投稿の応答検証は別に失敗することがあります。この履歴は接続テスト成功では消えません。自動判定が停止したタブは、問題の解消後にXを再読み込みしてください（再送信・課金の可能性があります）。診断にはキー・投稿本文・アカウント情報を含みません。` : '';
}
const testControlsInput = document.getElementById('show-test-controls');
chrome.storage.local.get({ showTestControls: false }).then(s => { testControlsInput.checked = s.showTestControls === true; });
testControlsInput.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ showTestControls: testControlsInput.checked, mockMode: false });
    document.getElementById('test-controls-status').textContent = '保存しました。Xへ戻ると反映されます。';
  } catch { document.getElementById('test-controls-status').textContent = '保存できませんでした。再度お試しください。'; }
});

let status = null;
let busy = false;
let statusRequest = 0;
let displaySettings = { allowReveal: false, scoreThreshold: 25, hideQuotes: false, showUncertain: false };
let displayReady = false;
let displayBusy = false;
let displayRequest = 0;

function setFeedback(message, isError = false) {
  actionStatus.textContent = message;
  actionStatus.dataset.state = isError ? 'error' : 'ok';
}

function updateControls() {
  const checking = status?.keyState === 'checking';
  enabledInput.disabled = busy || !status;
  autoJudgeInput.disabled = busy || !status || (!status.autoJudgeEnabled && status.keyState !== 'valid');
  apiKeyInput.disabled = busy || checking;
  saveKeyButton.disabled = busy || checking;
  deleteKeyButton.disabled = busy || !status?.hasKey;
  testButton.disabled = busy || checking || !status?.hasKey || !status?.hasPermission;
  textTestButton.disabled = testButton.disabled || !displayReady || displayBusy;
  testTextInput.disabled = busy;
  refreshButton.disabled = busy;
  keyForm.setAttribute('aria-busy', String(busy || checking));
  for (const control of [allowRevealInput, hideQuotesInput, showUncertainInput, thresholdInput, thresholdRange]) {
    control.disabled = busy || displayBusy || !displayReady;
  }
}

function isValidThreshold(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function showDisplaySettings() {
  allowRevealInput.checked = displaySettings.allowReveal;
  hideQuotesInput.checked = displaySettings.hideQuotes;
  showUncertainInput.checked = displaySettings.showUncertain;
  thresholdInput.value = String(displaySettings.scoreThreshold);
  thresholdRange.value = String(displaySettings.scoreThreshold);
  if (textTestResult) showTextTestResult();
}

function showTextTestStatus(message, error = false) {
  textTestStatus.hidden = false;
  textTestStatus.textContent = message;
  textTestStatus.dataset.state = error ? 'error' : 'ok';
}
function clearTextTestResult() {
  textTestResult = null;
  textTestDetails.replaceChildren();
  textTestDetails.hidden = true;
}
function showTextTestResult() {
  const result = NyanJevCore.classify(textTestResult, displaySettings.scoreThreshold);
  const decision = result.hide ? 'NG — にゃーん（猫表示）' : 'OK — 原文を表示';
  const reason = result.hide ? '不快感スコアが閾値以上です。' : '不快感スコアが閾値未満です。';
  showTextTestStatus(`${decision}\n読後の不快感 ${result.normalized.toFixed(2)} / 100 · 閾値 ${displaySettings.scoreThreshold}\n${reason}`);
  textTestStatus.dataset.state = result.hide ? 'blocked' : 'ok';
  textTestDetails.replaceChildren();
  const note = document.createElement('p'); note.className = 'note';
  note.textContent = '0は嫌な気持ちにならない、100は強く嫌な気持ちになる目安です。判定はスコアと閾値の比較だけです。閾値変更はこの結果を再計算し、再送信しません。';
  textTestDetails.append(note); textTestDetails.hidden = false;
}
testTextInput.addEventListener('input', () => {
  clearTextTestResult(); textTestStatus.hidden = true;
});
textTestForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || textTestButton.disabled) return;
  clearTextTestResult();
  let text = testTextInput.value.trim();
  if (!text || text.length > NyanJevCore.MAX_TEXT_LENGTH) {
    showTextTestStatus('1〜6000文字のテスト文を入力してください。送信していません。', true); return;
  }
  setBusy(true); showTextTestStatus('入力したテスト文を送信して判定中…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_TEST_TEXT', text });
    if (response?.ok === true) {
      textTestResult = NyanJevCore.classify(response.result, displaySettings.scoreThreshold);
      showTextTestResult();
    } else {
      const delivery = response?.sent === true ? '送信後に失敗しました。' : response?.sent === false ? '送信せず停止しました。' : '送信状況は不明です。';
      showTextTestStatus(`判定エラー — OK / NGは確定していません。${delivery} ${failureLabel(response?.code, response?.diagnostic)}。`, true);
    }
  } catch {
    clearTextTestResult(); showTextTestStatus('判定エラー — 結果を確認できません。送信・課金済みの可能性があるため、連続実行しないでください。', true);
  } finally { text = ''; setBusy(false); }
});

function setDisplayFeedback(message, isError = false) {
  displayFeedback.textContent = message;
  displayFeedback.dataset.state = isError ? 'error' : 'ok';
}

async function refreshDisplaySettings() {
  const request = ++displayRequest;
  try {
    const stored = await chrome.storage.local.get({ allowReveal: false, scoreThreshold: 25, hideQuotes: false, showUncertain: false });
    if (request !== displayRequest) return false;
    displaySettings = {
      allowReveal: stored.allowReveal === true,
      hideQuotes: stored.hideQuotes === true,
      showUncertain: stored.showUncertain === true,
      scoreThreshold: isValidThreshold(stored.scoreThreshold) ? stored.scoreThreshold : 25,
    };
    displayReady = true;
    showDisplaySettings();
    updateControls();
    return true;
  } catch {
    if (request === displayRequest) {
      displayReady = false;
      setDisplayFeedback('表示設定を取得できませんでした。「状態を再確認」を押してください。', true);
      updateControls();
    }
    return false;
  }
}

async function saveDisplaySetting(key, value) {
  if (busy || displayBusy || !displayReady) return;
  if ((key === 'scoreThreshold' && !isValidThreshold(value)) || (['allowReveal', 'hideQuotes', 'showUncertain'].includes(key) && typeof value !== 'boolean')) {
    showDisplaySettings();
    setDisplayFeedback('閾値は0〜100の整数で入力してください。設定は変更していません。', true);
    return;
  }
  displayBusy = true;
  updateControls();
  try {
    await chrome.storage.local.set({ [key]: value });
    displaySettings[key] = value;
    showDisplaySettings();
    setDisplayFeedback('保存しました。評価済み投稿の表示に反映されます。APIへの再送信はありません。');
  } catch {
    showDisplaySettings();
    setDisplayFeedback('表示設定を保存できませんでした。設定は元の値に戻しました。', true);
  } finally {
    displayBusy = false;
    updateControls();
  }
}

allowRevealInput.addEventListener('change', () => {
  void saveDisplaySetting('allowReveal', allowRevealInput.checked);
});
hideQuotesInput.addEventListener('change', () => { void saveDisplaySetting('hideQuotes', hideQuotesInput.checked); });
showUncertainInput.addEventListener('change', () => { void saveDisplaySetting('showUncertain', showUncertainInput.checked); });
thresholdRange.addEventListener('input', () => {
  thresholdInput.value = thresholdRange.value;
});
thresholdRange.addEventListener('change', () => {
  void saveDisplaySetting('scoreThreshold', thresholdRange.valueAsNumber);
});
thresholdInput.addEventListener('input', () => {
  if (isValidThreshold(thresholdInput.valueAsNumber)) thresholdRange.value = thresholdInput.value;
});
thresholdInput.addEventListener('change', () => {
  void saveDisplaySetting('scoreThreshold', thresholdInput.valueAsNumber);
});

function setBusy(value) {
  busy = value;
  updateControls();
}

function showKeyState(keyState, checkedAt = null) {
  keyStateBadge.textContent = KEY_STATES[keyState] || '状態を確認できません';
  keyStateBadge.dataset.state = Object.hasOwn(KEY_STATES, keyState) ? keyState : 'unknown';
  document.getElementById('key-status').textContent = KEY_STATES[keyState] || '確認できません';
  apiKeyInput.placeholder = keyState === 'missing' ? 'APIキーを入力' : Object.hasOwn(KEY_STATES, keyState) ?
    'キーは保存済みです（変更する場合のみ入力）' : '状態を再確認してください';
  keyCheckedAt.textContent = Number.isFinite(checkedAt) && checkedAt > 0 && Number.isFinite(new Date(checkedAt).getTime()) ?
    `最終確認: ${new Date(checkedAt).toLocaleString('ja-JP')}（その時点の接続結果）` : '';
}

function showUnavailable() {
  status = null;
  showPostError(null);
  connectionStatus.textContent = '状態を取得できませんでした。「状態を再確認」を押してください。';
  connectionStatus.dataset.state = 'error';
  for (const id of ['key-status', 'permission-status', 'model-status']) {
    document.getElementById(id).textContent = '確認できません';
  }
  enabledInput.checked = false;
  autoJudgeInput.checked = false;
  autoStatus.textContent = '自動判定の状態を確認できません。';
  showKeyState('unknown');
  updateControls();
}

async function refreshStatus() {
  const request = ++statusRequest;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_STATUS' });
    if (request !== statusRequest) return false;
    if (!response || ['enabled', 'hasKey', 'hasPermission', 'autoJudgeEnabled'].some(key => typeof response[key] !== 'boolean') ||
        !Object.hasOwn(KEY_STATES, response.keyState) || !Number.isInteger(response.autoRemaining) ||
        response.autoRemaining < 0 || response.autoRemaining > 200) {
      throw new Error('Invalid status');
    }
    status = response;
    showPostError(status.lastPostError);
    enabledInput.checked = status.enabled;
    autoJudgeInput.checked = status.autoJudgeEnabled;
    showKeyState(status.keyState, status.keyCheckedAt);
    document.getElementById('permission-status').textContent = status.hasPermission ? '許可済み' : '未許可';
    document.getElementById('model-status').textContent = typeof status.model === 'string' && /^[a-zA-Z0-9._/-]{1,80}$/.test(status.model) ? status.model : '確認できません';
    connectionStatus.dataset.state = 'ok';
    if (status.keyState === 'checking') {
      connectionStatus.textContent = '固定の架空テキストで接続確認中です。自動判定は確認完了まで待機します。';
    } else if (!status.enabled) {
      connectionStatus.textContent = '投稿のJev判定はOFFです。キー保存時の接続確認・接続テストは実行できます。';
    } else if (!status.hasKey || !status.hasPermission) {
      connectionStatus.textContent = '接続の準備が必要です。APIキーと通信権限を確認してください。';
    } else if (status.filterEnabled === false) {
      connectionStatus.textContent = '拡張全体がOFFです。投稿の判定は停止しています。';
    } else if (status.autoJudgeEnabled && status.keyState === 'valid' && status.autoRemaining > 0) {
      connectionStatus.textContent = '自動判定がONです。対象候補の本文を投稿ごとの確認なしでJevへ送ります。';
    } else if (status.autoJudgeEnabled) {
      connectionStatus.textContent = '自動判定は停止／待機中です。個別判定を使う場合は自動判定をOFFにしてください。';
    } else {
      connectionStatus.textContent = '個別の確認操作で判定できます。自動判定の状態は下で確認してください。';
    }
    const remaining = `このセッションの自動判定: 残り ${status.autoRemaining} / 200 件（全タブ合計・失敗や中止も消費）`;
    const autoState = !status.autoJudgeEnabled ? '自動判定はOFFです。' : status.keyState !== 'valid' ? '自動判定は接続確認済みのキーを待っています。' :
      !status.hasPermission ? '通信権限がないため自動判定は停止中です。' : !status.enabled || status.filterEnabled === false ? 'Jev判定または拡張全体がOFFのため自動判定は停止中です。' :
      status.autoRemaining === 0 ? '上限に達したため自動判定は停止中です。' : '自動判定はONです。';
    autoStatus.textContent = `${autoState} ${remaining}`;
    updateControls();
    return true;
  } catch {
    if (request === statusRequest) showUnavailable();
    return false;
  }
}

function wasSuccessful(response) {
  return response && response.ok !== false && (response.ok === true || typeof response.hasKey === 'boolean');
}

keyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  let apiKey = apiKeyInput.value.trim();
  apiKeyInput.value = '';
  if (!apiKey) {
    setFeedback('APIキーを入力してください。', true);
    apiKeyInput.focus();
    return;
  }
  setBusy(true);
  setFeedback('通信権限を確認しています…');
  try {
    // Keep this request inside the direct user gesture; never request on page load.
    const granted = await chrome.permissions.request({ origins: [permissionOrigin] });
    if (!granted) {
      setFeedback('通信権限が許可されなかったため、キーを保存しませんでした。', true);
      return;
    }
    showKeyState('checking');
    setFeedback('キーを保存し、固定の架空テキストで接続確認中です…');
    const response = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_SAVE_KEY', apiKey });
    if (!wasSuccessful(response)) throw new Error('Save failed');
    if (response.verified === true) {
      setFeedback('このセッションにキーを保存し、接続を確認しました。Jev判定・自動判定の設定は変更していません。');
    } else {
      setFeedback('キーは保存しましたが、' + failureLabel(response.code, response.diagnostic) + '。接続テストで再確認してください。送信済み・課金済みの場合があります。', true);
    }
  } catch {
    setFeedback('キー保存・接続確認の結果を確認できませんでした。送信済みの可能性があるため、状態を再確認してからやり直してください。', true);
  } finally {
    apiKey = '';
    await refreshStatus();
    setBusy(false);
  }
});

deleteKeyButton.addEventListener('click', async () => {
  if (busy) return;
  apiKeyInput.value = '';
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_DELETE_KEY' });
    if (!wasSuccessful(response)) throw new Error('Delete failed');
    setFeedback('セッションのキーを削除しました。送信済みデータは取り消されません。');
  } catch {
    setFeedback('キーの削除を確認できませんでした。状態を再確認してください。', true);
  } finally {
    await refreshStatus();
    setBusy(false);
  }
});

enabledInput.addEventListener('change', async () => {
  if (busy || !status) return;
  const enabled = enabledInput.checked;
  setBusy(true);
  try {
    await chrome.storage.local.set({ jevEnabled: enabled });
    setFeedback(enabled ? 'Jev判定を有効にしました。自動判定がONで接続確認済みの場合は、対象候補の送信を開始します。' : 'Jev判定をOFFにしました。送信済みデータは取り消されません。');
  } catch {
    setFeedback('設定を保存できませんでした。状態を再確認してください。', true);
  } finally {
    await refreshStatus();
    setBusy(false);
  }
});

autoJudgeInput.addEventListener('change', async () => {
  if (busy || !status) return;
  const enabled = autoJudgeInput.checked;
  setBusy(true);
  try {
    if (enabled && status.keyState !== 'valid') {
      setFeedback('自動判定をONにする前に、キーの接続確認を完了してください。', true);
      return;
    }
    const stored = await chrome.storage.local.get({ autoJudgeConsentVersion: 0 });
    if (enabled && stored.autoJudgeConsentVersion !== AUTO_CONSENT_VERSION) {
      const agreed = globalThis.confirm('自動判定を有効にしますか？\n\nHTMLの鍵・限定表示などを確認しますが、鍵マークがないことは公開の証明ではありません。検出漏れにより、非公開・限定公開の本文をTypeSafeのJevへ外部送信してしまう可能性があります。\n\n対象候補は投稿ごとの確認なしで自動送信され、API料金が発生する可能性があります。自動判定はこのブラウザセッションで全タブ合計200件までです。失敗・中止も上限を消費し、手動判定・接続テストは別です。\n\n送信済みデータは取り消せません。この同意はXや投稿者の利用許諾を代替しません。リスクと送信する権限を確認して、有効にする場合だけ「OK」を押してください。');
      if (!agreed) { setFeedback('自動判定は有効にしませんでした。'); return; }
    }
    await chrome.storage.local.set(enabled ? { autoJudgeEnabled: true, autoJudgeConsentVersion: AUTO_CONSENT_VERSION } : { autoJudgeEnabled: false });
    setFeedback(enabled ? '自動判定をONにしました。Jev判定と拡張全体がONの場合、候補の本文を自動送信します。' : '自動判定をOFFにしました。送信済みデータは取り消されません。');
  } catch {
    setFeedback('自動判定の設定を確認できませんでした。状態を再確認してください。', true);
  } finally {
    await refreshStatus();
    setBusy(false);
  }
});

testButton.addEventListener('click', async () => {
  if (busy || status?.keyState === 'checking' || !status?.hasKey || !status.hasPermission) return;
  setBusy(true);
  showKeyState('checking');
  testResult.textContent = '固定の架空テキストを送信して確認中…';
  setFeedback('接続テスト中です。');
  try {
    // The service worker owns the fixed sample. Never send page text or key here.
    const response = await chrome.runtime.sendMessage({ type: 'NYAN_JEV_TEST_SAMPLE' });
    if (!response || typeof response.ok !== 'boolean') throw new Error('Invalid test response');
    if (response.ok) {
      testResult.textContent = '接続に成功し、架空の日本語テキストの評価結果を受信しました。';
      setFeedback('接続テストが完了しました。X上の投稿は送信していません。');
    } else {
      const delivery = response.sent === true ? 'APIへの送信後に失敗しました。' : response.sent === false ? 'APIへ送信せずに停止しました。' : '送信状況は確認できません。';
      testResult.textContent = `${delivery} ${failureLabel(response.code, response.diagnostic)}。設定を確認してから再実行してください。`;
      setFeedback('接続テストを完了できませんでした。', true);
    }
  } catch {
    testResult.textContent = '接続テストの結果を確認できませんでした。送信済みの可能性があるため、連続して再実行しないでください。';
    setFeedback('状態を再確認してください。', true);
  } finally {
    await refreshStatus();
    setBusy(false);
  }
});

refreshButton.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  const [available, displayAvailable] = await Promise.all([refreshStatus(), refreshDisplaySettings()]);
  setBusy(false);
  setFeedback(available ? '現在の状態を確認しました。' : '拡張の状態を取得できませんでした。', !available);
  if (displayAvailable) setDisplayFeedback('表示設定を確認しました。');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.jevEnabled || changes.enabled || changes.autoJudgeEnabled || changes.jevConfigRevision)) void refreshStatus();
  if (!displayBusy && area === 'local' && (changes.allowReveal || changes.scoreThreshold || changes.hideQuotes || changes.showUncertain)) void refreshDisplaySettings();
});
chrome.permissions.onRemoved.addListener(() => { void refreshStatus(); });
chrome.permissions.onAdded.addListener(() => { void refreshStatus(); });
window.addEventListener('pagehide', () => { apiKeyInput.value = ''; testTextInput.value = ''; clearTextTestResult(); });
window.addEventListener('focus', () => { void refreshStatus(); });

void refreshStatus();
void refreshDisplaySettings().then(ready => { if (ready) setDisplayFeedback('表示設定を確認しました。'); });
