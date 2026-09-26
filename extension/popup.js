'use strict';
const enabled = document.getElementById('enabled');
const mockMode = document.getElementById('mock-mode');
chrome.storage.local.get({ enabled: true, mockMode: false, showTestControls: false }).then(settings => {
  enabled.checked = settings.enabled; mockMode.checked = settings.showTestControls && settings.mockMode;
  document.getElementById('debug-controls').hidden = !settings.showTestControls;
});
document.getElementById('open-settings').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
enabled.addEventListener('change', () => chrome.storage.local.set({ enabled: enabled.checked }));
mockMode.addEventListener('change', () => chrome.storage.local.set({ mockMode: mockMode.checked }));
async function message(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No tab');
  return chrome.tabs.sendMessage(tab.id, { type });
}
async function updateCounts() {
  try {
    const s = await message('NYAN_STATUS');
    document.getElementById('counts').textContent = `候補 ${s.candidate} / 制限 ${s.restricted} / 不明 ${s.unknown} / 猫表示 ${s.masked} / 判定済 ${s.evaluated} / API試行 ${s.sent}` +
      (s.autoPausedCode ? ' / 自動判定はエラーで一時停止。設定で接続確認後OFF→ONで再開。' : '');
  } catch { document.getElementById('counts').textContent = 'Xのホーム・投稿詳細・検索を開いて再読み込みしてください。'; }
}
chrome.runtime.sendMessage({ type: 'NYAN_JEV_STATUS' }).then(s => {
  document.getElementById('jev-status').textContent = !s.enabled ? 'Jev：OFF（自動送信なし）' : s.hasKey && s.hasPermission ?
    s.autoJudgeEnabled ? `Jev：自動モード / 接続確認 ${s.keyState === 'valid' ? '済' : '必要'} / 残り ${s.autoRemaining}件` : 'Jev：個別確認して送信できます' : 'Jev：キー・通信権限の設定が必要です';
}).catch(() => { document.getElementById('jev-status').textContent = 'Jev設定を確認できません'; });
document.getElementById('reset-tests').addEventListener('click', async () => { try { await message('NYAN_RESET_TESTS'); await updateCounts(); } catch {} });
updateCounts();
setInterval(updateCounts, 1000);
