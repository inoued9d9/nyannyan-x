// Authored quote fixtures only. HTTP(S) is blocked; no X account or real API is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.NYAN_PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve(__dirname, '../extension');
const QUOTED = '引用先だけの架空本文・外部送信禁止の検査文字列';
const OUTER = '外側の作者が書いた架空本文です。';

function quote(kind = 'quoteTweet', { body = QUOTED, restricted = true } = {}) {
  const tag = kind === 'nested' ? 'article' : 'div';
  const attribute = kind === 'nested' ? 'data-testid="tweet"' : kind === 'fixture' ? 'data-nyan-quote' :
    kind === 'role' ? 'role="link" tabindex="0"' : `data-testid="${kind}"`;
  return `<${tag} ${attribute}><div data-testid="User-Name"><a href="/quoted">架空の引用作者</a>${restricted ? '<span aria-label="Protected account">鍵</span>' : ''}</div><a href="/quoted/status/90001"><time>昨日</time></a>${body === null ? '<div data-testid="tweetPhoto">架空の画像のみ</div>' : `<div data-testid="tweetText">${body}</div>`}${restricted ? '<div data-testid="socialContext">Subscribers only</div>' : ''}</${tag}>`;
}
function post(id, number, { body = OUTER, embedded = '', protectedParent = false, before = false } = {}) {
  const text = body === null ? '' : `<div data-testid="tweetText">${body}</div>`;
  return `<article data-testid="tweet" id="${id}"><header><div data-testid="User-Name"><a href="/outer">架空の外側作者</a>${protectedParent ? '<span aria-label="Protected account">鍵</span>' : ''}</div><a href="/outer/status/${number}"><time>1分</time></a></header>${before ? embedded + text : text + embedded}</article>`;
}
const quotedIds = ['known', 'alternate', 'unavailable', 'fixture', 'nested', 'role', 'media', 'before',
  'protected-parent', 'missing-body', 'empty-body', 'spaces-body', 'ambiguous', 'role-without-outer', 'boundary-in-text'];
function fixtures() {
  return `<main><div data-testid="primaryColumn">${[
    post('plain', 100),
    post('known', 101, { embedded: quote() }),
    post('alternate', 102, { embedded: quote('quotedTweet') }),
    post('unavailable', 103, { embedded: quote('tweetUnavailable', { body: null }) }),
    post('fixture', 104, { embedded: quote('fixture') }),
    post('nested', 105, { embedded: quote('nested') }),
    post('role', 106, { embedded: quote('role') }),
    post('media', 107, { embedded: quote('nested', { body: null }) }),
    post('before', 108, { embedded: quote(), before: true }),
    post('protected-parent', 109, { embedded: quote(), protectedParent: true }),
    post('missing-body', 110, { body: null, embedded: quote() }),
    post('empty-body', 111, { body: '', embedded: quote() }),
    post('spaces-body', 112, { body: '   ', embedded: quote() }),
    post('ambiguous', 113, { embedded: `<div data-testid="tweetText">${QUOTED}</div>` }),
    post('role-without-outer', 114, { body: null, embedded: quote('role', { restricted: false }) }),
    post('boundary-in-text', 115, { body: OUTER + quote('fixture') }),
    post('inline-link', 116, { body: '架空の本文 <a role="link" href="/quoted/status/90001">参照リンク</a><br>続き<img alt="🐈">' }),
    `<aside data-testid="DMDrawer">${post('dm-panel', 117, { embedded: quote() })}</aside>`,
    `<div role="dialog">${post('dialog', 118, { embedded: quote() })}</div>`
  ].join('')}</div></main>`;
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.NYAN_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(5000);
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.route('**/*', route => /^https?:/.test(route.request().url()) ? route.abort() : route.continue());
  let passed = 0;
  async function check(label, action) { await action(); passed++; console.log(`PASS ${label}`); }
  const ui = id => page.locator(`#${id} > [data-nyan-ui]`);
  const original = id => page.locator(`#${id} > [data-testid="tweetText"]`);
  const masked = id => page.locator(`#${id}`).getAttribute('data-nyan-masked');
  const inspect = id => page.evaluate(id => NyanAdapter.inspect(document.getElementById(id), 'live'), id);
  const snapshot = id => page.evaluate(id => {
    try { return { ok: true, text: NyanAdapter.snapshot(document.getElementById(id)) }; }
    catch { return { ok: false }; }
  }, id);
  async function setup() {
    await page.evaluate(() => globalThis.quoteFilter?.stop());
    await page.setContent(fixtures());
    for (const script of ['policy.js', 'jev-core.js', 'adapter.js', 'filter.js']) {
      await page.addScriptTag({ path: path.join(extension, script) });
    }
    await page.addStyleTag({ path: path.join(extension, 'filter.css') });
    await page.evaluate(() => {
      globalThis.quotePath = '/home';
      globalThis.quoteCalls = [];
      globalThis.quoteConfirmations = 0;
      globalThis.quoteAborts = 0;
      globalThis.quoteResult = {
        model: 'jev-1.13.0', rubric: 'discomfort-v1', normalized: 90, score: 90,
        hide: true, uncertain: false, reason: '読後の不快感'
      };
      globalThis.quoteFilter = NyanFilter.create({ root: document, mode: 'live', getPath: () => quotePath,
        confirmSend: () => { quoteConfirmations++; return true; },
        onEvaluate: payload => {
          quoteCalls.push({ text: payload.text, postId: payload.postId, outerBodyOnly: payload.outerBodyOnly });
          payload.signal.addEventListener('abort', () => { quoteAborts++; }, { once: true });
          return new Promise(resolve => { globalThis.finishQuoteEvaluation = () => resolve({ ok: true, sent: true, result: quoteResult }); });
        }
      });
      quoteFilter.setJevReady(true);
      quoteFilter.start();
    });
  }

  try {
    await setup();
    await check('plain posts and inline status links are not classified as quotes', async () => {
      for (const id of ['plain', 'inline-link']) {
        const info = await inspect(id);
        assert.equal(info.isQuote, false, id);
        assert.equal(info.bodyIsolated, true, id);
        assert.equal(info.decision.visibility, 'candidate', id);
      }
      assert.deepEqual(await snapshot('inline-link'), { ok: true, text: '架空の本文 参照リンク\n続き🐈' });
    });
    await check('known quote containers, nested articles and media-only quotes isolate outer text', async () => {
      for (const id of ['known', 'alternate', 'unavailable', 'fixture', 'nested', 'media', 'before']) {
        const info = await inspect(id);
        assert.equal(info.isQuote, true, id);
        assert.equal(info.bodyIsolated, true, id);
        assert.deepEqual(await snapshot(id), { ok: true, text: OUTER }, id);
      }
    });
    await check('role-link quote with a complete unique outer post has a safe boundary', async () => {
      const info = await inspect('role');
      assert.equal(info.isQuote, true);
      assert.equal(info.bodyIsolated, true);
      assert.equal(info.identity, '/outer/status/106');
      assert.deepEqual(await snapshot('role'), { ok: true, text: OUTER });
    });
    await check('private quoted author and subscriber labels do not contaminate outer metadata', async () => {
      for (const id of ['known', 'alternate', 'fixture', 'nested', 'role', 'before']) {
        const info = await inspect(id);
        assert.equal(info.name, '架空の外側作者', id);
        assert.match(info.identity, /^\/outer\/status\//, id);
        assert.equal(info.decision.visibility, 'candidate', id);
        const result = await snapshot(id);
        assert.equal(result.text.includes(QUOTED), false, id);
        assert.equal(result.text.includes('架空の引用作者'), false, id);
      }
    });
    await check('a protected outer author stays restricted and direct snapshot is denied', async () => {
      const info = await inspect('protected-parent');
      assert.equal(info.isQuote, true);
      assert.equal(info.bodyIsolated, true);
      assert.equal(info.decision.visibility, 'restricted');
      assert.deepEqual(await snapshot('protected-parent'), { ok: false });
      assert.equal(await ui('protected-parent').locator('button').count(), 0);
    });
    await check('missing, empty and whitespace-only outer bodies never fall back to quoted text', async () => {
      for (const id of ['missing-body', 'empty-body', 'spaces-body']) {
        const info = await inspect(id);
        assert.equal(info.isQuote, true, id);
        assert.equal(info.bodyIsolated, false, id);
        assert.equal(info.decision.visibility, 'unknown', id);
        assert.deepEqual(await snapshot(id), { ok: false }, id);
      }
    });
    await check('ambiguous boundaries and quotes nested inside outer tweetText fail closed', async () => {
      for (const id of ['ambiguous', 'role-without-outer', 'boundary-in-text']) {
        const info = await inspect(id);
        assert.equal(info.isQuote, true, id);
        assert.equal(info.bodyIsolated, false, id);
        assert.equal(info.decision.visibility, 'unknown', id);
        assert.deepEqual(await snapshot(id), { ok: false }, id);
      }
    });
    await check('quote hiding defaults off, all originals remain and no API is invoked', async () => {
      assert.equal(await page.evaluate(() => quoteFilter.getStats().hideQuotes), false);
      assert.equal(await page.locator('[data-nyan-masked]').count(), 0);
      assert.equal(await original('known').isVisible(), true);
      assert.equal(await original('protected-parent').isVisible(), true);
      assert.equal(await page.evaluate(() => quoteCalls.length), 0);
      assert.equal(await page.evaluate(() => quoteConfirmations), 0);
    });
    await check('enabling quote hiding masks every quote locally, including unknown and private parents', async () => {
      await page.evaluate(() => quoteFilter.setHideQuotes(true));
      for (const id of quotedIds) {
        assert.equal(await masked(id), 'true', id);
        assert.match(await ui(id).innerText(), /引用RT\s*·\s*未判定/, id);
        assert.match(await ui(id).locator('.nyan-reason').getAttribute('title'), /Jevにも送りません/, id);
        assert.equal(await ui(id).locator('[data-nyan-send]').count(), 0, id);
      }
      assert.equal(await masked('plain'), null);
      assert.equal(await original('plain').isVisible(), true);
      assert.equal(await masked('inline-link'), null);
      assert.equal(await page.evaluate(() => quoteCalls.length), 0);
      assert.equal(await page.evaluate(() => quoteConfirmations), 0);
      assert.equal(await page.evaluate(() => quoteFilter.getStats().evaluated), 0);
    });
    await check('DM panels and dialogs are excluded even when their embedded posts contain quotes', async () => {
      for (const id of ['dm-panel', 'dialog']) {
        assert.equal(await masked(id), null, id);
        assert.equal(await ui(id).count(), 0, id);
        assert.equal(await original(id).isVisible(), true, id);
        assert.deepEqual(await snapshot(id), { ok: false }, id);
      }
    });
    await check('reveal defaults off and opt-in permits local reveal without sending quotes', async () => {
      assert.equal(await ui('known').locator('button').count(), 0);
      await page.evaluate(() => quoteFilter.setAllowReveal(true));
      await ui('known').getByRole('button', { name: '原文に戻す' }).click();
      assert.equal(await masked('known'), null);
      assert.equal(await original('known').isVisible(), true);
      assert.equal(await ui('known').locator('[data-nyan-send]').count(), 0);
      assert.equal(await page.evaluate(() => quoteCalls.length), 0);
      await page.evaluate(() => quoteFilter.setAllowReveal(false));
      assert.equal(await masked('known'), 'true');
      assert.equal(await ui('known').locator('button').count(), 0);
    });
    await check('revealed protected quote keeps its restriction and reveal state across refreshes', async () => {
      await page.evaluate(() => quoteFilter.setAllowReveal(true));
      await ui('protected-parent').getByRole('button', { name: '原文に戻す' }).click();
      await page.evaluate(() => {
        document.querySelector('#protected-parent header time').textContent = '2分';
        quoteFilter.refresh();
      });
      await page.waitForFunction(() => !document.getElementById('protected-parent').hasAttribute('data-nyan-masked'));
      assert.equal((await inspect('protected-parent')).decision.visibility, 'restricted');
      assert.equal(await original('protected-parent').isVisible(), true);
      assert.equal(await ui('protected-parent').locator('[data-nyan-send]').count(), 0);
      assert.equal(await page.evaluate(() => quoteFilter.getStats().restricted), 1);
      assert.equal(await page.evaluate(() => quoteCalls.length), 0);
    });
    await check('turning quote hiding off restores intact originals and original diagnostic decisions', async () => {
      await page.evaluate(() => quoteFilter.setHideQuotes(false));
      assert.equal(await page.locator('[data-nyan-masked]').count(), 0);
      assert.equal(await original('known').innerText(), OUTER);
      assert.equal(await page.locator('#known [data-testid="quoteTweet"] [data-testid="tweetText"]').innerText(), QUOTED);
      assert.equal((await inspect('known')).decision.visibility, 'candidate');
      assert.equal((await inspect('protected-parent')).decision.visibility, 'restricted');
      assert.equal((await inspect('ambiguous')).decision.visibility, 'unknown');
      assert.equal(await page.evaluate(() => quoteCalls.length), 0);
    });
    await check('home, reply and search routes apply quote hiding; DM routes clear all UI', async () => {
      await page.evaluate(() => quoteFilter.setHideQuotes(true));
      for (const route of ['/home', '/outer/status/101', '/i/web/status/101', '/search?q=fiction&f=live']) {
        await page.evaluate(route => { quotePath = route; quoteFilter.refresh(); }, route);
        assert.equal(await masked('known'), 'true', route);
        assert.equal(await masked('plain'), null, route);
      }
      for (const route of ['/messages', '/messages/123', '/i/chat/123']) {
        await page.evaluate(route => { quotePath = route; quoteFilter.refresh(); }, route);
        assert.equal(await page.locator('[data-nyan-ui],[data-nyan-masked],[data-nyan-attached]').count(), 0, route);
      }
      await page.evaluate(() => { quotePath = '/home'; quoteFilter.refresh(); });
      assert.equal(await masked('known'), 'true');
      assert.equal(await page.evaluate(() => quoteCalls.length), 0);
    });
    await check('a permitted manual fake evaluation receives only the isolated outer body', async () => {
      await setup();
      await ui('known').locator('[data-nyan-send]').click();
      await page.waitForFunction(() => quoteCalls.length === 1);
      assert.deepEqual(await page.evaluate(() => quoteCalls[0]), { text: OUTER, postId: '101', outerBodyOnly: true });
      assert.equal(await page.evaluate(() => quoteConfirmations), 1);
    });
    await check('enabling quote hiding cancels pending work and ignores the later fake result', async () => {
      await page.evaluate(() => quoteFilter.setHideQuotes(true));
      assert.equal(await page.evaluate(() => quoteAborts), 1);
      await page.evaluate(() => finishQuoteEvaluation());
      await page.waitForFunction(() => quoteFilter.getStats().sent === 1);
      assert.equal(await masked('known'), 'true');
      assert.match(await ui('known').innerText(), /引用RT\s*·\s*未判定/);
      assert.equal(await page.evaluate(() => quoteFilter.getStats().evaluated), 0);
      assert.equal(await page.evaluate(() => quoteCalls.length), 1);
      await page.evaluate(() => quoteFilter.setHideQuotes(false));
      assert.equal(await masked('known'), null);
      assert.equal(await page.evaluate(() => quoteFilter.getStats().evaluated), 0);
    });
    await check('stop restores original metadata and removes only filter attributes and UI', async () => {
      await page.evaluate(() => { quoteFilter.setHideQuotes(true); quoteFilter.stop(); });
      assert.equal(await page.locator('[data-nyan-ui],[data-nyan-masked],[data-nyan-attached]').count(), 0);
      assert.equal(await original('known').innerText(), OUTER);
      assert.equal(await page.locator('#known [data-testid="quoteTweet"] [data-testid="tweetText"]').innerText(), QUOTED);
      assert.equal(await page.locator('#protected-parent > header [aria-label="Protected account"]').count(), 1);
    });
    await check('all quote checks finish without browser errors or HTTP requests', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(network, []);
    });
    console.log(`${passed} quote boundary and local visibility checks passed. No real API calls or real posts were used.`);
  } finally {
    await page.evaluate(() => globalThis.quoteFilter?.stop()).catch(() => {});
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
