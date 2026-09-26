// Real unpacked MV3 extension, isolated browser profile, authored X fixtures only.
// HTTP is blocked except locally fulfilled X pages; worker fetch is also blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.NYAN_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const fakeKey = 'nyan-fixture-key-never-valid-or-transmitted';

function post(id, { protectedPost = false, incomplete = false, extra = '' } = {}) {
  return `<article data-testid="tweet" id="${id}"><header><div data-testid="User-Name"><a href="/fictional">架空の名前 ${id}</a><span>@fictional</span>${protectedPost ? '<span aria-label="非公開アカウント">🔒</span>' : ''}</div>${incomplete ? '' : `<a href="/fictional/status/${100 + id.length}"><time>1分</time></a>`}</header><div data-testid="tweetText">これは自作の架空テスト本文です。${id}</div>${extra}</article>`;
}

function fixture() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空投稿だけの拡張テスト</title><style>body{font:14px/1.6 system-ui;margin:0;background:#f5faf7;color:#183a31}main{max-width:700px;margin:30px auto}article{background:white;border:1px solid #d7e5dd;border-radius:10px;padding:12px;margin:10px 0}header{font-size:12px;color:#536b61}header a{color:inherit}header span{margin-left:8px}h1{font-size:20px}aside{border:1px dashed #aaa;padding:10px}</style></head><body><main><h1>架空投稿のローカルテスト</h1><p>実アカウント・実投稿・外部APIは使用していません。</p><div data-testid="primaryColumn">${post('candidate')}${post('protected', { protectedPost: true })}${post('unknown', { incomplete: true })}${post('quoted', { extra: '<div data-nyan-quote><div data-testid="tweetText">架空の未確認引用</div></div>' })}<aside data-testid="DMDrawer">${post('dm')}</aside><div role="dialog">${post('dialog')}</div></div></main></body></html>`;
}

async function main() {
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const profile = await fs.mkdtemp(path.join(artifacts, 'browser-profile-'));
  const extension = path.join(root, 'extension');
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: process.env.NYAN_BROWSER_CHANNEL || undefined,
    viewport: { width: 1200, height: 1100 }, colorScheme: 'light',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-background-networking', '--host-resolver-rules=MAP api.typesafe.ai 0.0.0.0']
  });
  const errors = [], externalRequests = [], guardedWorkers = new Set();
  const workerGuards = [];
  let passed = 0;
  async function guardWorker(worker) {
    if (guardedWorkers.has(worker)) return;
    guardedWorkers.add(worker);
    await worker.evaluate(() => {
      self.__nyanTestFetchAttempts = [];
      self.__nyanTestPayloads = [];
      self.fetch = async (input, init) => {
        self.__nyanTestFetchAttempts.push(typeof input === 'string' ? input : input.url);
        if (self.__nyanTestReply) {
          self.__nyanTestPayload = JSON.parse(init.body);
          self.__nyanTestPayloads.push(self.__nyanTestPayload);
          if (self.__nyanTestDelay) await new Promise(resolve => setTimeout(resolve, self.__nyanTestDelay));
          return new Response(JSON.stringify(self.__nyanTestReply), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error('External fetch blocked by fixture test');
      };
    });
  }
  context.on('serviceworker', worker => { workerGuards.push(guardWorker(worker)); });
  const observe = page => page.on('pageerror', error => errors.push(error.message));
  for (const page of context.pages()) observe(page);
  context.on('page', observe);
  context.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  async function check(label, action) {
    await action(); passed++; console.log(`PASS ${label}`);
  }
  try {
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://x.com') return route.fulfill({ contentType: 'text/html', body: fixture() });
      if (url.protocol === 'chrome-extension:' || url.protocol === 'data:') return route.continue();
      externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await guardWorker(worker);
    await Promise.all(workerGuards);
    const optionsUrl = await worker.evaluate(() => chrome.runtime.getURL('options.html'));
    const extensionOrigin = new URL(optionsUrl).origin;
    const extensionId = new URL(optionsUrl).hostname;
    const page = context.pages()[0];
    const cdp = await context.newCDPSession(page);
    const contexts = new Map();
    cdp.on('Runtime.executionContextCreated', ({ context: executionContext }) => contexts.set(executionContext.id, executionContext));
    cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
    cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
    await cdp.send('Runtime.enable');
    await page.goto('https://x.com/home');
    await page.waitForSelector('#candidate > [data-nyan-ui="status"]');
    const popup = await context.newPage();
    await popup.goto(await worker.evaluate(() => chrome.runtime.getURL('popup.html')));
    await popup.waitForSelector('#open-settings');
    assert.equal(await popup.locator('#debug-controls').isVisible(), false);
    const openingOptions = context.waitForEvent('page');
    await popup.locator('#open-settings').click();
    const options = await openingOptions;
    await options.waitForURL(optionsUrl);
    await options.waitForFunction(() => !document.getElementById('score-threshold').disabled && !document.getElementById('jev-enabled').disabled);
    await check('popup settings button opens the real extension options tab', async () => {
      assert.equal(options.url(), optionsUrl);
      assert.equal(await options.locator('#api-key').getAttribute('type'), 'password');
      assert.equal(await options.locator('#score-threshold').isEnabled(), true);
    });
    await check('settings exposes bundled data disclosure, risks and exact MIT license', async () => {
      await options.locator('header a[href="about.html"]').click();
      await options.waitForURL(await worker.evaluate(() => chrome.runtime.getURL('about.html')));
      assert.match(await options.locator('body').innerText(), /Authorization/);
      assert.match(await options.locator('body').innerText(), /無保証・責任制限/);
      await options.locator('a[href="LICENSE.txt"]').click();
      assert.match(await options.locator('body').innerText(), /MIT License/);
      assert.match(await options.locator('body').innerText(), /THE SOFTWARE IS PROVIDED "AS IS"/);
      await options.goto(optionsUrl);
      await options.waitForFunction(() => !document.getElementById('score-threshold').disabled);
    });
    await popup.close();

    await check('real MV3 defaults preserve originals, isolate extension world, and exclude protected/DM/dialog/unknown', async () => {
      assert.equal(await page.evaluate(() => typeof window.NyanFilter), 'undefined');
      for (const id of ['candidate', 'protected', 'unknown', 'quoted', 'dm', 'dialog']) {
        assert.equal(await page.locator(`#${id} > [data-testid="tweetText"]`).isVisible(), true);
      }
      for (const id of ['protected', 'unknown', 'quoted']) assert.equal(await page.locator(`#${id} > [data-nyan-ui] button`).count(), 0);
      for (const id of ['dm', 'dialog']) assert.equal(await page.locator(`#${id} [data-nyan-ui]`).count(), 0);
      assert.match(await page.locator('#candidate > [data-nyan-ui]').innerText(), /未判定.*公開性未確認/);
      assert.equal(await page.locator('#candidate > [data-nyan-ui] button').count(), 0);
      assert.equal(await page.locator('[data-nyan-send]').count(), 0);
      assert.equal(await options.locator('#allow-reveal').isChecked(), false);
      assert.equal(await options.locator('#hide-quotes').isChecked(), false);
      assert.equal(await options.locator('#score-threshold').inputValue(), '25');
      assert.equal(await options.locator('#jev-enabled').isChecked(), false);
      assert.equal(await options.locator('#test-sample').isDisabled(), true);
    });

    await check('quote blanket option updates the real tab locally with Jev disabled', async () => {
      await options.locator('#hide-quotes').check();
      await page.waitForSelector('#quoted[data-nyan-masked="true"]');
      assert.match(await page.locator('#quoted .nyan-reason').innerText(), /引用RT.*未判定/);
      assert.equal(await page.locator('#candidate').getAttribute('data-nyan-masked'), null);
      await options.locator('#hide-quotes').uncheck();
      await page.waitForFunction(() => !document.getElementById('quoted').hasAttribute('data-nyan-masked'));
    });

    await check('synthetic cat replacement is compact, has no default reveal, and does not bubble card navigation', async () => {
      await options.getByText('開発用・表示テスト', { exact: true }).click();
      await options.locator('#show-test-controls').check();
      await page.waitForSelector('#candidate > [data-nyan-ui] button');
      await page.evaluate(() => {
        window.fixtureCardClicks = 0;
        document.getElementById('candidate').addEventListener('click', () => { window.fixtureCardClicks++; });
      });
      await page.locator('#candidate > [data-nyan-ui] button').click();
      await page.waitForSelector('#candidate > [data-nyan-ui="replacement"]');
      assert.equal(await page.locator('#candidate .nyan-author').innerText(), 'ねこ');
      assert.equal(await page.locator('#candidate > [data-testid="tweetText"]').isVisible(), false);
      assert.equal(await page.locator('#candidate > [data-nyan-ui] button').count(), 0);
      const card = page.locator('#candidate > [data-nyan-ui]');
      assert.ok((await card.boundingBox()).height <= 56, 'Replacement should be a compact row');
      await card.click();
      assert.equal(await page.evaluate(() => window.fixtureCardClicks), 0);
      assert.equal(page.url(), 'https://x.com/home');
      assert.equal(await page.locator('#candidate > [data-testid="tweetText"]').isVisible(), false);
      await page.screenshot({ path: path.join(artifacts, 'compact-replacement.png'), fullPage: true });
    });

    await check('options allowReveal applies through real storage events; turning it off hides a revealed mock result again', async () => {
      // Persistent mock mode deliberately retains the synthetic hide decision after reveal.
      await options.evaluate(() => chrome.storage.local.set({ mockMode: true }));
      await options.locator('#allow-reveal').check();
      await page.waitForSelector('#candidate > [data-nyan-ui="replacement"] button');
      assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('allowReveal')).allowReveal), true);
      await page.locator('#candidate').getByRole('button', { name: '原文に戻す', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('candidate').hasAttribute('data-nyan-masked'));
      assert.equal(await page.locator('#candidate > [data-testid="tweetText"]').isVisible(), true);
      await options.locator('#allow-reveal').uncheck();
      await page.waitForSelector('#candidate[data-nyan-masked="true"] > [data-nyan-ui="replacement"]');
      assert.equal(await page.locator('#candidate > [data-nyan-ui] button').count(), 0);
      await options.evaluate(() => chrome.storage.local.set({ mockMode: false }));
      await page.waitForFunction(() => !document.getElementById('candidate').hasAttribute('data-nyan-masked'));
    });

    await check('threshold number/range save integers; empty, non-numeric, fractional and out-of-range values are rejected', async () => {
      for (const value of ['0', '100', '42']) {
        await options.locator('#score-threshold').fill(value);
        await options.locator('#score-threshold').dispatchEvent('change');
        await options.waitForFunction(expected => document.getElementById('score-threshold-range').value === expected && !document.getElementById('score-threshold').disabled, value);
        assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('scoreThreshold')).scoreThreshold), Number(value));
      }
      for (const value of ['', 'NaN', 'Infinity', '-1', '101', '42.5']) {
        await options.locator('#score-threshold').evaluate((input, invalid) => { input.value = invalid; input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
        assert.equal(await options.locator('#score-threshold').inputValue(), '42');
        assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('scoreThreshold')).scoreThreshold), 42);
      }
      await options.locator('#score-threshold-range').evaluate(input => {
        input.value = '65'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await options.waitForFunction(() => document.getElementById('score-threshold').value === '65' && !document.getElementById('score-threshold').disabled);
      assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('scoreThreshold')).scoreThreshold), 65);
      await options.screenshot({ path: path.join(artifacts, 'options-settings.png'), fullPage: true });
    });

    await check('no-permission key save is denied; fake session key stays in trusted extension contexts and is deletable', async () => {
      const denied = await options.evaluate(apiKey => chrome.runtime.sendMessage({ type: 'NYAN_JEV_SAVE_KEY', apiKey }), fakeKey);
      assert.equal(denied.ok, false);
      assert.equal(await worker.evaluate(async () => Boolean((await chrome.storage.session.get('jevApiKey')).jevApiKey)), false);
      // Fixture setup only, not a claim that headless permission approval was tested.
      await worker.evaluate(apiKey => chrome.storage.session.set({ jevApiKey: apiKey }), fakeKey);
      const isolated = [...contexts.values()].find(item => item.auxData?.type === 'isolated' &&
        (item.origin === extensionOrigin || item.origin === `chrome-extension://${extensionId}` || item.name.includes(extensionId)));
      assert.ok(isolated, 'Content-script isolated execution context must be observable');
      const access = await cdp.send('Runtime.evaluate', {
        contextId: isolated.id, awaitPromise: true, returnByValue: true,
        expression: '(async () => { try { await chrome.storage.session.get("jevApiKey"); return { allowed: true }; } catch { return { allowed: false }; } })()'
      });
      assert.equal(access.result.value.allowed, false, 'Content scripts must not read session API keys');
      const state = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'NYAN_JEV_STATUS' }));
      assert.equal(state.hasKey, true);
      assert.equal(Object.hasOwn(state, 'apiKey') || Object.hasOwn(state, 'jevApiKey'), false);
      assert.equal(await options.locator('#api-key').inputValue(), '');
      assert.equal(await options.evaluate(async () => Object.hasOwn(await chrome.storage.local.get(null), 'jevApiKey')), false);
      const deleted = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'NYAN_JEV_DELETE_KEY' }));
      assert.equal(deleted.ok, true);
      assert.equal(await worker.evaluate(async () => Boolean((await chrome.storage.session.get('jevApiKey')).jevApiKey)), false);
    });

    await check('manual content-to-worker flow uses one mocked API call; strength changes only reclassify locally', async () => {
      // Explicit test doubles: this does NOT test the user's permission approval or live API.
      await worker.evaluate(async apiKey => {
        self.__nyanRealContains = chrome.permissions.contains;
        chrome.permissions.contains = async () => true;
        const score = level => ({ type: 'score', score: level, confidence: 1,
          probabilities: Object.fromEntries([0, 1, 2, 3].map(n => [String(n), n === level ? 1 : 0])) });
        self.__nyanTestReply = { model: 'jev-1.13.0', answers: {
          discomfort: score(2)
        } };
        await chrome.storage.session.set({ jevApiKey: apiKey });
        await chrome.storage.local.set({ jevEnabled: true, showTestControls: false, mockMode: false, scoreThreshold: 65 });
      }, fakeKey);
      await page.waitForSelector('#candidate [data-nyan-send]');
      assert.equal(await page.getByRole('button', { name: '置換をテスト', exact: true }).count(), 0);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#candidate [data-nyan-send]').click();
      await page.waitForSelector('#candidate[data-nyan-masked="true"]');
      assert.equal(await page.locator('#candidate .nyan-reason').innerText(), 'Jev 67');
      assert.equal(await page.locator('#candidate [data-nyan-ui] button').count(), 0);
      const payload = await worker.evaluate(() => self.__nyanTestPayload);
      assert.deepEqual(Object.keys(payload).sort(), ['model', 'questions', 'state']);
      assert.deepEqual(Object.keys(payload.state), ['text']);
      assert.deepEqual(Object.keys(payload.questions), ['discomfort']);
      assert.equal(payload.state.text, 'これは自作の架空テスト本文です。candidate');
      await options.locator('#score-threshold').fill('85');
      await options.locator('#score-threshold').dispatchEvent('change');
      await page.waitForFunction(() => !document.getElementById('candidate').hasAttribute('data-nyan-masked'));
      await options.locator('#score-threshold').fill('65');
      await options.locator('#score-threshold').dispatchEvent('change');
      await page.waitForSelector('#candidate[data-nyan-masked="true"]');
      assert.equal(await worker.evaluate(() => self.__nyanTestFetchAttempts.length), 1);
      await worker.evaluate(async () => {
        chrome.permissions.contains = self.__nyanRealContains;
        self.__nyanTestReply = null;
        await chrome.storage.session.remove('jevApiKey');
        await chrome.storage.local.set({ jevEnabled: false });
      });
    });

    await check('saving the key verifies one fictional sample with Jev OFF and updates both settings tabs', async () => {
      await worker.evaluate(() => {
        chrome.permissions.contains = async () => true;
        const score = level => ({ type: 'score', score: level, confidence: 1,
          probabilities: Object.fromEntries([0, 1, 2, 3].map(n => [String(n), n === level ? 1 : 0])) });
        self.__nyanTestReply = { model: 'jev-1.13.0', answers: {
          discomfort: score(2)
        } };
        self.__nyanTestDelay = 300;
      });
      await options.evaluate(() => { chrome.permissions.request = async () => true; });
      await options.locator('#refresh-status').click();
      await options.locator('#api-key').fill(fakeKey);
      await options.locator('#save-key').click();
      await options.waitForFunction(() => document.getElementById('key-state-badge').dataset.state === 'checking');
      await options.waitForFunction(() => document.getElementById('key-state-badge').dataset.state === 'valid' && !document.getElementById('save-key').disabled);
      assert.match(await options.locator('#api-key').getAttribute('placeholder'), /保存済み/);
      assert.equal(await options.locator('#api-key').inputValue(), '');
      assert.equal(await options.locator('#jev-enabled').isChecked(), false);
      assert.equal(await options.locator('#auto-judge-enabled').isChecked(), false);
      const payloads = await worker.evaluate(() => self.__nyanTestPayloads);
      assert.equal(payloads.length, 2);
      assert.equal(payloads[1].state.text, 'この説明は根拠が不足していると思います。参考資料を教えてください。');
      const second = await context.newPage(); await second.goto(optionsUrl);
      await second.waitForFunction(() => document.getElementById('key-state-badge').dataset.state === 'valid');
      await second.close();
    });
    await check('auto opt-in judges without post clicks and preserves the final reserved request', async () => {
      await worker.evaluate(async () => {
        await chrome.storage.session.set({ jevAutoSentCount: 199 });
        self.__nyanTestDelay = 500;
      });
      await options.locator('#jev-enabled').check();
      await options.waitForFunction(() => !document.getElementById('auto-judge-enabled').disabled);
      // Start a fresh fixture page so there is no previous manual numeric result.
      await page.goto('https://x.com/search?q=fixture');
      await page.waitForSelector('#candidate > [data-nyan-ui="status"]');
      options.once('dialog', dialog => dialog.accept());
      await options.locator('#auto-judge-enabled').check();
      await options.waitForFunction(() => document.getElementById('auto-status').textContent.includes('残り 0'));
      await page.waitForSelector('#candidate[data-nyan-masked]');
      assert.equal(await page.locator('#candidate .nyan-reason').innerText(), 'Jev 67');
      assert.equal(await page.locator('#quoted > [data-testid="tweetText"]').isVisible(), false);
      assert.match(await page.locator('#quoted > [data-nyan-ui]').innerText(), /上限/);
      assert.equal(await page.locator('#protected > [data-testid="tweetText"]').isVisible(), true);
      assert.equal(await page.locator('[data-nyan-send]').count(), 0);
      const payloads = await worker.evaluate(() => self.__nyanTestPayloads);
      assert.equal(payloads.length, 3);
      assert.equal(payloads[2].state.text, 'これは自作の架空テスト本文です。candidate');
      await options.locator('#auto-judge-enabled').uncheck();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-nyan-auto-cover'));
      await options.locator('#jev-enabled').uncheck();
      await worker.evaluate(async () => {
        chrome.permissions.contains = self.__nyanRealContains;
        self.__nyanTestReply = null;
        await chrome.storage.session.remove('jevApiKey');
      });
    });
    await check('custom text test uses one discomfort score, OK/NG without confidence holds, and safe errors', async () => {
      await worker.evaluate(async apiKey => {
        chrome.permissions.contains = async () => true;
        self.__nyanTestDelay = 120;
        const low = () => ({ type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 } });
        self.__nyanCleanReply = { model: 'jev-1.13.0', answers: {
          discomfort: low()
        } };
        self.__nyanTestReply = structuredClone(self.__nyanCleanReply);
        await chrome.storage.session.set({ jevApiKey: apiKey, jevKeyState: 'valid', jevKeyCheckedAt: 12345 });
      }, fakeKey);
      await options.waitForFunction(() => !document.getElementById('test-text-send').disabled);
      const runText = async text => {
        await options.locator('#test-text').fill(text);
        assert.equal(await options.locator('#text-test-details').isVisible(), false);
        await options.locator('#test-text-send').click();
        await options.waitForFunction(() => !document.getElementById('test-text-send').disabled);
      };
      await runText('  ');
      assert.match(await options.locator('#text-test-status').innerText(), /送信していません/);
      assert.equal(await worker.evaluate(() => self.__nyanTestFetchAttempts.length), 3);
      await runText('これは自作の架空テスト文です。<img src=x onerror=alert(1)>');
      assert.match(await options.locator('#text-test-status').innerText(), /^OK/);
      assert.equal(await options.locator('#text-test-details table').count(), 0);
      assert.match(await options.locator('#text-test-status').innerText(), /読後の不快感 0.00/);
      assert.equal(await options.locator('#text-test-details img').count(), 0);
      assert.equal((await worker.evaluate(() => self.__nyanTestPayload)).state.text, 'これは自作の架空テスト文です。<img src=x onerror=alert(1)>');
      await worker.evaluate(() => {
        // Synthetic independently rounded mixture, not a captured live response.
        self.__nyanTestReply.answers.discomfort = { type: 'score', score: 2.03, confidence: .8,
          probabilities: { 0: .01, 1: .01, 2: .91, 3: .07 } };
      });
      await runText('猫表示の架空テスト');
      assert.match(await options.locator('#text-test-status').innerText(), /^NG.*にゃーん/);
      assert.match(await options.locator('#text-test-status').innerText(), /67.67/);
      assert.equal(await options.locator('#text-test-status').getAttribute('data-state'), 'blocked');
      await options.locator('[aria-labelledby="text-test-title"]').screenshot({ path: path.join(artifacts, 'custom-text-result.png') });
      await options.locator('#score-threshold').fill('90');
      await options.locator('#score-threshold').dispatchEvent('change');
      await options.waitForFunction(() => document.getElementById('text-test-status').textContent.startsWith('OK'));
      assert.equal(await worker.evaluate(() => self.__nyanTestFetchAttempts.length), 5);
      await options.locator('#score-threshold').fill('65');
      await options.locator('#score-threshold').dispatchEvent('change');
      await options.waitForFunction(() => document.getElementById('text-test-status').textContent.startsWith('NG'));
      await worker.evaluate(() => { self.__nyanTestReply.answers.discomfort.confidence = .01; });
      await runText('嫌');
      assert.match(await options.locator('#text-test-status').innerText(), /^NG.*\n読後の不快感 67.67/);
      assert.doesNotMatch(await options.locator('#text-test-details').innerText(), /文脈十分度|攻撃確率|確信度/);
      await worker.evaluate(() => { self.__nyanTestReply.answers.discomfort.probabilities = { 0: .1, 1: .1, 2: .1, 3: .1 }; });
      await runText('応答エラーの架空テスト');
      assert.match(await options.locator('#text-test-status').innerText(), /判定エラー.*PROBABILITY_TOTAL/);
      assert.equal(await options.locator('#text-test-details').isVisible(), false);
      assert.equal(await options.locator('#key-state-badge').getAttribute('data-state'), 'valid');
      assert.equal(await options.locator('#post-error-status').isVisible(), false);
      await options.locator('#prompt-details summary').click();
      const prompt = JSON.parse(await options.locator('#judge-prompt').innerText());
      assert.deepEqual(Object.keys(prompt), ['discomfort']);
      assert.match(prompt.discomfort.instructions, /嫌な気持ち/);
      await options.screenshot({ path: path.join(artifacts, 'custom-text-test.png'), fullPage: true });
    });
    await check('real post response error is visible in settings even after fixed connection check succeeds', async () => {
      await options.locator('#jev-enabled').check();
      await page.goto('https://x.com/home');
      await page.waitForSelector('#candidate [data-nyan-send]');
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#candidate [data-nyan-send]').click();
      await options.waitForFunction(() => document.getElementById('post-error-status').textContent.includes('PROBABILITY_TOTAL'));
      assert.equal(await options.locator('#post-error-status').isVisible(), true);
      assert.equal(await options.locator('#key-state-badge').getAttribute('data-state'), 'valid');
      await worker.evaluate(() => { self.__nyanTestReply = self.__nyanCleanReply; });
      await options.locator('#test-sample').click();
      await options.waitForFunction(() => document.getElementById('test-result').textContent.includes('接続に成功'));
      assert.match(await options.locator('#post-error-status').innerText(), /PROBABILITY_TOTAL/);
      assert.equal((await options.locator('body').innerText()).includes(fakeKey), false);
      await options.locator('#jev-enabled').uncheck();
      await options.reload();
      await options.waitForFunction(() => !document.getElementById('test-text-send').disabled);
      assert.equal(await options.locator('#test-text').inputValue(), '');
      assert.equal(await options.locator('#text-test-details').isVisible(), false);
      await options.locator('#delete-key').click();
      await options.waitForFunction(() => document.getElementById('key-state-badge').dataset.state === 'missing');
      assert.equal(await options.locator('#post-error-status').isVisible(), false);
    });
    await check('search and reply routes inject; SPA and full DM routes are excluded', async () => {
      for (const route of ['/search?q=fixture', '/fictional/status/123']) {
        await page.goto(`https://x.com${route}`);
        await page.waitForSelector('#candidate > [data-nyan-ui="status"]');
        assert.equal(await page.locator('#dm [data-nyan-ui]').count(), 0);
      }
      await page.evaluate(() => history.pushState({}, '', '/i/chat/123'));
      await page.waitForFunction(() => !document.querySelector('[data-nyan-ui]'));
      await page.goto('https://x.com/messages');
      await page.waitForTimeout(500);
      assert.equal(await page.locator('[data-nyan-ui]').count(), 0);
      assert.equal(await page.locator('#candidate > [data-testid="tweetText"]').isVisible(), true);
    });

    await check('no runtime errors or external requests; only nine mocked API attempts', async () => {
      await Promise.all(workerGuards);
      const attempts = (await Promise.all([...guardedWorkers].map(guarded => guarded.evaluate(() => self.__nyanTestFetchAttempts)))).flat();
      assert.deepEqual(attempts, Array(9).fill('https://api.typesafe.ai/v1/systemone'));
      const payloads = await worker.evaluate(() => self.__nyanTestPayloads);
      for (const payload of payloads) assert.deepEqual(Object.keys(payload.questions), ['discomfort']);
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(errors, []);
    });
    console.log(`${passed} real MV3 checks passed. Fixture-only screenshots: artifacts/options-settings.png, artifacts/compact-replacement.png. No real API calls.`);
  } finally { await context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
