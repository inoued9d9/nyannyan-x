// Authored DOM fixtures and fake scores only. HTTP(S) is blocked.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.NYAN_PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve(__dirname, '../extension');
function post(id, body = 'HIGH 自作の架空本文', options = {}) {
  return `<article data-testid="tweet" id="p${id}"><header><div data-testid="User-Name"><a href="/fiction">架空の作者</a>${options.private ? '<span aria-label="非公開アカウント">鍵</span>' : ''}</div>${options.unknown ? '' : `<a href="/fiction/status/${id}"><time>1分</time></a>`}</header>${options.sub ? '<div data-testid="socialContext">Subscribers only</div>' : ''}<div data-testid="tweetText">${body}</div>${options.quote ? '<article data-testid="tweet"><div data-testid="User-Name"><span aria-label="Protected account">架空の引用作者</span></div><a href="/quoted/status/999"><time>昨日</time></a><div data-testid="tweetText">QUOTED DO NOT SEND 架空の引用先</div></article>' : ''}</article>`;
}
async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.NYAN_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (/^https?:/.test(route.request().url())) { network.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  let count = 0;
  const check = async (name, action) => { await action(); console.log('PASS ' + name); count++; };
  async function setup(html = post(1), { automatic = true, ready = true, response = 'success', hideQuotes = false } = {}) {
    await page.evaluate(() => window.filter?.stop());
    await page.setContent(`<main><div data-testid="primaryColumn">${html}</div></main>`);
    for (const file of ['policy.js', 'jev-core.js', 'adapter.js', 'filter.js']) await page.addScriptTag({ path: path.join(extension, file) });
    await page.addStyleTag({ path: path.join(extension, 'filter.css') });
    await page.evaluate(({ automatic, ready, response, hideQuotes }) => {
      window.calls = []; window.pending = []; window.confirms = 0; window.route = '/home'; window.responseMode = response;
      window.makeScore = (low = false, confidence = 1) => NyanJevCore.parseResponse({ model: 'jev-1.13.0',
        answers: { discomfort: { type: 'score', score: low ? 0 : 3, confidence,
          probabilities: { '0': low ? 1 : 0, '1': 0, '2': 0, '3': low ? 0 : 1 } } } });
      window.filter = NyanFilter.create({ root: document, mode: 'live', getPath: () => window.route,
        confirmSend: () => { window.confirms++; return true; },
        onEvaluate: async input => {
          window.calls.push(input);
          if (window.responseMode === 'busy-once' && window.calls.length === 1) return { ok: false, sent: false, code: 'BUSY' };
          if (window.responseMode === 'pending') return new Promise(resolve => window.pending.push(resolve));
          if (window.responseMode === 'failure') return { ok: false, sent: true, error: 'never-display-raw-error' };
          return { ok: true, sent: true, result: window.makeScore(input.text.includes('LOW')) };
        }
      });
      filter.setAutoJudgeEnabled(automatic); filter.setHideQuotes(hideQuotes); filter.setJevReady(ready); filter.start();
    }, { automatic, ready, response, hideQuotes });
  }
  const original = id => page.locator(`#p${id} > [data-testid="tweetText"]`);
  try {
    await check('automatic mode is opt-in; default manual mode never starts a request', async () => {
      await setup(post(1), { automatic: false });
      await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => calls.length), 0);
      assert.equal(await original(1).isVisible(), true);
    });
    await check('unready auto mode covers candidates but preserves restricted, unknown and excluded regions', async () => {
      await setup(post(1) + post(2, 'PRIVATE', { private: true }) + post(3, 'SUB', { sub: true }) + post(4, 'UNKNOWN', { unknown: true }) +
        `<aside data-testid="DMDrawer">${post(5)}</aside><div role="dialog">${post(6)}</div><form>${post(7)}</form>`, { ready: false });
      assert.equal(await original(1).isVisible(), false);
      for (const id of [2, 3, 4, 5, 6, 7]) assert.equal(await original(id).isVisible(), true);
      assert.equal(await page.locator('#p1 button').count(), 0);
      assert.equal(await page.evaluate(() => calls.length), 0);
    });
    await check('no clicks: auto classifies outer bodies, cats high scores, and shows low scores', async () => {
      await setup(post(1) + post(2, 'LOW 架空本文') + post(3, 'HIGH 外側本文のみ', { quote: true }));
      await page.waitForSelector('#p3[data-nyan-masked]');
      assert.equal(await original(1).isVisible(), false);
      assert.equal(await original(2).isVisible(), true);
      const payloads = await page.evaluate(() => calls.map(({ signal, ...value }) => value));
      assert.equal(payloads.length, 3);
      assert.ok(payloads.every(value => value.automatic && value.domEligible && !value.publicConfirmed && value.outerBodyOnly));
      assert.equal(payloads[2].text, 'HIGH 外側本文のみ');
      assert.equal(payloads[2].isQuote, true);
      assert.equal(await page.evaluate(() => confirms), 0);
      assert.equal(await page.locator('[data-nyan-send]').count(), 0);
    });
    await check('cached same-ID same-body remount and threshold edits do not resend', async () => {
      await page.evaluate(html => { document.getElementById('p1').remove(); document.querySelector('main > div').insertAdjacentHTML('afterbegin', html); filter.setScoreThreshold(100); }, post(1));
      await page.waitForSelector('#p1[data-nyan-masked]');
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => calls.length), 3);
    });
    await check('mixed hidden text is never sent; making it visible admits the complete body', async () => {
      await setup(post(1, 'LOW visible fixture <span hidden>previously hidden fixture</span>'));
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => calls.length), 0);
      assert.equal(await page.locator('#p1[data-nyan-masked]').count(), 0);
      await page.evaluate(() => document.querySelector('#p1 [data-testid="tweetText"] span').removeAttribute('hidden'));
      await page.waitForFunction(() => filter.getStats().evaluated === 1);
      assert.equal(await page.evaluate(() => calls[0].text), 'LOW visible fixture previously hidden fixture');
      assert.equal(await original(1).isVisible(), true);
    });
    await check('hidden quote-source text never blocks or joins the visible outer body', async () => {
      await setup(post(1, 'LOW outer fixture only', { quote: true }).replace('QUOTED DO NOT SEND 架空の引用先', '<span hidden>QUOTED HIDDEN FIXTURE</span>'));
      await page.waitForFunction(() => filter.getStats().evaluated === 1);
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal(await page.evaluate(() => calls[0].text), 'LOW outer fixture only');
    });
    await check('source inspection keeps pre-cover, holding and cat states clipped and restores all DOM state', async () => {
      await setup(post(1), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 1);
      await page.evaluate(() => {
        window.inspectGuard = item => {
          const before = item.outerHTML;
          const coverBefore = document.documentElement.getAttribute('data-nyan-auto-cover');
          const computedStyle = window.getComputedStyle;
          const clips = [];
          let text, eligible;
          window.getComputedStyle = function (...args) {
            if (item.hasAttribute('data-nyan-inspecting')) {
              const guard = computedStyle.call(window, item);
              clips.push({ clip: guard.clipPath, pointerEvents: guard.pointerEvents });
            }
            return computedStyle.apply(window, args);
          };
          try {
            for (let repeat = 0; repeat < 5; repeat++) {
              eligible = NyanAdapter.inspect(item, 'live').decision.eligibleForTest;
              text = NyanAdapter.snapshot(item);
            }
          } finally { window.getComputedStyle = computedStyle; }
          return { unchanged: before === item.outerHTML,
            coverUnchanged: coverBefore === document.documentElement.getAttribute('data-nyan-auto-cover'),
            lingeringGuard: item.hasAttribute('data-nyan-inspecting'), eligible, text, clips };
        };
      });
      const assertGuard = result => {
        assert.equal(result.unchanged, true);
        assert.equal(result.coverUnchanged, true);
        assert.equal(result.lingeringGuard, false);
        assert.equal(result.eligible, true);
        assert.equal(result.text, 'HIGH 自作の架空本文');
        assert.ok(result.clips.length > 0);
        assert.ok(result.clips.every(({ clip, pointerEvents }) => clip === 'inset(100%)' && pointerEvents === 'none'));
      };
      assertGuard(await page.evaluate(() => inspectGuard(document.getElementById('p1'))));
      assert.equal(await original(1).isVisible(), false);
      await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: makeScore() }));
      await page.waitForSelector('#p1[data-nyan-masked]');
      assertGuard(await page.evaluate(() => inspectGuard(document.getElementById('p1'))));
      assertGuard(await page.evaluate(html => {
        document.querySelector('main > div').insertAdjacentHTML('beforeend', html);
        const item = document.getElementById('p99');
        const result = inspectGuard(item); item.remove(); return result;
      }, post(99)));
      await page.evaluate(() => { for (let repeat = 0; repeat < 10; repeat++) filter.refresh(); });
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal(await page.evaluate(() => filter.getStats().evaluated), 1);
      assert.equal(await page.locator('#p1 > [data-nyan-ui]').count(), 1);
      assert.equal(await page.locator('[data-nyan-inspecting]').count(), 0);
      assert.equal(await original(1).isVisible(), false);
      const unavailableStyle = await page.evaluate(() => {
        const item = document.getElementById('p1');
        const before = item.outerHTML;
        const computedStyle = window.getComputedStyle;
        let eligible, rejected = false;
        window.getComputedStyle = () => { throw new Error('fixture: style context unavailable'); };
        try {
          eligible = NyanAdapter.inspect(item, 'live').decision.eligibleForTest;
          try { NyanAdapter.snapshot(item); } catch { rejected = true; }
        } finally { window.getComputedStyle = computedStyle; }
        return { eligible, rejected, unchanged: before === item.outerHTML };
      });
      assert.deepEqual(unavailableStyle, { eligible: false, rejected: true, unchanged: true });
    });
    await check('quote blanket hides quotes without scoring, including protected quotes', async () => {
      await setup(post(1, 'HIGH', { quote: true }) + post(2, 'PRIVATE', { quote: true, private: true }), { hideQuotes: true });
      await page.waitForTimeout(700);
      assert.equal(await page.locator('[data-nyan-masked]').count(), 2);
      assert.equal(await page.evaluate(() => calls.length), 0);
    });
    await check('failed auto results remain covered and never silently retry', async () => {
      await setup(post(1), { response: 'failure' });
      await page.waitForFunction(() => calls.length === 1 && !filter.getStats().evaluated);
      await page.waitForTimeout(1200);
      assert.equal(await original(1).isVisible(), false);
      assert.equal(await page.locator('#p1[data-nyan-masked]').count(), 0);
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal((await page.locator('body').innerText()).includes('never-display-raw-error'), false);
    });
    await check('reveal requires the existing setting; OFF rehides an unjudged original', async () => {
      assert.equal(await page.locator('#p1 button').count(), 0);
      await page.evaluate(() => filter.setAllowReveal(true));
      await page.getByRole('button', { name: '未判定の原文を表示', exact: true }).click();
      assert.equal(await original(1).isVisible(), true);
      await page.evaluate(() => filter.setAllowReveal(false));
      assert.equal(await original(1).isVisible(), false);
    });
    for (const change of ['auto-off', 'private', 'body', 'hidden-body', 'hidden-css-body', 'hidden-descendant', 'hidden-ancestor', 'hidden-post', 'identity', 'dm-route', 'dm-move', 'quote-blanket', 'stop']) {
      await check(`pending ${change} aborts and discards the old result`, async () => {
        await setup(post(1, 'HIGH', { quote: change === 'quote-blanket' }), { response: 'pending' });
        await page.waitForFunction(() => calls.length === 1);
        await page.evaluate(change => {
          const item = document.getElementById('p1');
          if (change === 'auto-off') filter.setAutoJudgeEnabled(false);
          if (change === 'private') item.querySelector('[data-testid="User-Name"]').insertAdjacentHTML('beforeend', '<span aria-label="Protected account">鍵</span>');
          if (change === 'body') item.querySelector('[data-testid="tweetText"]').textContent = 'LOW 新しい本文';
          if (change === 'hidden-body') item.querySelector('[data-testid="tweetText"]').hidden = true;
          if (change === 'hidden-css-body') item.querySelector('[data-testid="tweetText"]').style.display = 'none';
          if (change === 'hidden-post') item.style.display = 'none';
          if (change === 'hidden-descendant') item.querySelector('[data-testid="tweetText"]').insertAdjacentHTML('beforeend', '<span hidden>HIDDEN FIXTURE DO NOT SEND</span>');
          if (change === 'hidden-ancestor') {
            const body = item.querySelector('[data-testid="tweetText"]');
            const wrapper = document.createElement('div'); wrapper.style.opacity = '0';
            body.replaceWith(wrapper); wrapper.append(body);
          }
          if (change === 'identity') item.querySelector('header a[href*="/status/"]').href = '/fiction/status/82';
          if (change === 'dm-route') { window.route = '/messages'; filter.refresh(); }
          if (change === 'dm-move') { const panel = document.createElement('aside'); panel.dataset.testid = 'DMDrawer'; item.parentElement.append(panel); panel.append(item); }
          if (change === 'quote-blanket') filter.setHideQuotes(true);
          if (change === 'stop') filter.stop();
        }, change);
        await page.waitForFunction(() => calls[0].signal.aborted);
        await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: makeScore() }));
        await page.waitForTimeout(150);
        if (change !== 'quote-blanket') assert.equal(await page.locator('#p1[data-nyan-masked]').count(), 0);
        else assert.match(await page.locator('#p1 > [data-nyan-ui]').innerText(), /引用RT.*未判定/);
        assert.equal(await page.evaluate(() => filter.getStats().evaluated), 0);
      });
    }
    await check('the last reserved quota slot finishes while new posts remain held', async () => {
      await setup(post(1), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 1);
      await page.evaluate(() => filter.setAutoRemaining(0));
      await page.evaluate(html => document.querySelector('main > div').insertAdjacentHTML('beforeend', html), post(2));
      assert.equal(await page.evaluate(() => calls[0].signal.aborted), false);
      await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: makeScore() }));
      await page.waitForSelector('#p1[data-nyan-masked]');
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal(await original(2).isVisible(), false);
      assert.match(await page.locator('#p2 > [data-nyan-ui]').innerText(), /上限/);
    });
    await check('raising the quota above 200 resumes held posts without cancelling pending work or forgetting scores', async () => {
      await page.evaluate(() => filter.setAutoRemaining(500));
      await page.waitForFunction(() => calls.length === 2);
      assert.equal(await page.evaluate(() => filter.getStats().autoRemaining), 500);
      await page.evaluate(() => filter.setAutoRemaining(1000));
      assert.equal(await page.evaluate(() => calls[1].signal.aborted), false);
      await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: makeScore() }));
      await page.waitForFunction(() => filter.getStats().evaluated === 2);
      await page.evaluate(html => { document.querySelector('main > div').innerHTML = html; }, post(1) + post(2));
      await page.waitForSelector('#p2[data-nyan-masked]');
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => calls.length), 2);
      assert.equal(await page.evaluate(() => filter.getStats().evaluated), 2);
    });
    await check('only proven unsent quota denials are retried when remaining capacity returns', async () => {
      await setup(post(1), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 1);
      await page.evaluate(() => {
        filter.setAutoRemaining(0);
        pending.shift()({ ok: false, sent: false, code: 'AUTO_LIMIT' });
      });
      await page.waitForFunction(() => filter.getStats().autoPausedCode === 'AUTO_LIMIT');
      await page.evaluate(() => { filter.setAutoRemaining(0); filter.refresh(); });
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => calls.length), 1);
      await page.evaluate(() => { window.responseMode = 'success'; filter.setAutoRemaining(750); });
      await page.waitForSelector('#p1[data-nyan-masked]');
      assert.equal(await page.evaluate(() => calls.length), 2);
      assert.equal(await page.evaluate(() => filter.getStats().autoPausedCode), '');
    });
    for (const [code, sent] of [['AUTO_LIMIT', true], ['AUTO_LIMIT', undefined], ['RATE_LIMIT', true], ['CANCELLED', false], ['NETWORK', true]]) {
      await check(`quota reset never retries ${code} with sent=${String(sent)}`, async () => {
        await setup(post(1), { response: 'pending' });
        await page.waitForFunction(() => calls.length === 1);
        await page.evaluate(({ code, sent }) => pending.shift()({ ok: false, sent, code }), { code, sent });
        await page.waitForFunction(expected => filter.getStats().autoPausedCode === expected, code);
        await page.evaluate(html => {
          filter.setAutoRemaining(1000);
          document.querySelector('main > div').insertAdjacentHTML('beforeend', html);
        }, post(2));
        await page.waitForTimeout(650);
        assert.equal(await page.evaluate(() => calls.length), 1);
        assert.equal(await page.evaluate(() => filter.getStats().evaluated), 0);
        assert.equal(await original(1).isVisible(), false);
        assert.equal(await original(2).isVisible(), false);
      });
    }
    await check('two requests can run in parallel, but a third waits for capacity', async () => {
      await setup(post(1) + post(2) + post(3), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 2);
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => calls.length), 2);
      await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: makeScore() }));
      await page.waitForFunction(() => calls.length === 3);
      await page.evaluate(() => pending.splice(0).forEach(resolve => resolve({ ok: true, sent: true, result: makeScore() })));
      await page.waitForFunction(() => filter.getStats().evaluated === 3);
    });
    await check('cancelled delivery is not retried after readiness recovers', async () => {
      await setup(post(1), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 1);
      await page.evaluate(() => { filter.setJevReady(false); filter.setJevReady(true); pending.shift()({ ok: true, sent: true, result: makeScore() }); });
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal(await original(1).isVisible(), false);
      assert.equal(await page.locator('#p1[data-nyan-masked]').count(), 0);
    });
    await check('hidden and off-screen DOM is not sent; scrolling admits a nearby post', async () => {
      await setup(post(1) + `<div hidden>${post(2)}</div><div style="display:none">${post(3)}</div><div style="margin-top:10000px">${post(4)}</div>`);
      await page.waitForFunction(() => filter.getStats().evaluated === 1);
      await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal(await page.locator('#p2 [data-nyan-ui], #p3 [data-nyan-ui]').count(), 0);
      await page.locator('#p4').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => calls.length === 2);
      assert.equal(await page.evaluate(() => calls[1].postId), '4');
      await page.evaluate(() => window.scrollTo(0, 0));
    });
    await check('optional unjudged display reveals an error but never unmasks a high result', async () => {
      await setup(post(1) + post(2), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 2);
      await page.evaluate(() => {
        pending.shift()({ ok: false, sent: true, code: 'RATE_LIMIT' });
        pending.shift()({ ok: true, sent: true, result: makeScore() });
      });
      await page.waitForSelector('#p2[data-nyan-masked]');
      await page.evaluate(() => filter.setShowUncertain(true));
      assert.equal(await original(1).isVisible(), true);
      assert.match(await page.locator('#p1 > [data-nyan-ui]').innerText(), /未判定/);
      assert.equal(await original(2).isVisible(), false);
      await page.evaluate(() => filter.setShowUncertain(false));
      assert.equal(await original(1).isVisible(), false);
    });
    await check('connection errors pause new work; unjudged-display opt-in can expose originals', async () => {
      await setup(post(1) + post(2) + post(3), { response: 'failure' });
      await page.waitForFunction(() => Boolean(filter.getStats().autoPausedCode));
      await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => calls.length <= 2));
      await page.evaluate(() => filter.setShowUncertain(true));
      for (const id of [1, 2, 3]) assert.equal(await original(id).isVisible(), true);
      assert.match(await page.locator('#p3 > [data-nyan-ui]').innerText(), /未判定/);
    });
    await check('unjudged-display opt-in does not expose another request still in flight', async () => {
      await setup(post(1) + post(2), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 2);
      await page.evaluate(() => {
        filter.setShowUncertain(true);
        pending.shift()({ ok: false, sent: true, code: 'RATE_LIMIT' });
      });
      await page.waitForFunction(() => filter.getStats().autoPausedCode === 'RATE_LIMIT');
      assert.equal(await original(1).isVisible(), true);
      assert.equal(await original(2).isVisible(), false);
      await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: makeScore() }));
      await page.waitForSelector('#p2[data-nyan-masked]');
    });
    await check('short text and low confidence do not hold successful scores', async () => {
      await setup(post(1, '嫌い。') + post(2, '好き。'), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 2);
      await page.evaluate(() => {
        pending.shift()({ ok: true, sent: true, result: makeScore(false, 0.01) });
        pending.shift()({ ok: true, sent: true, result: makeScore(true, 0.01) });
      });
      await page.waitForFunction(() => filter.getStats().evaluated === 2);
      assert.equal(await page.locator('#p1[data-nyan-masked]').count(), 1);
      assert.equal(await original(2).isVisible(), true);
      assert.equal(await page.locator('[data-nyan-holding]').count(), 0);
      for (const id of [1, 2]) assert.doesNotMatch(await page.locator(`#p${id} > [data-nyan-ui]`).innerText(), /保留|確信度|文脈/);
    });
    await check('old multi-category results cannot be reused as new discomfort scores', async () => {
      await setup(post(1), { response: 'pending' });
      await page.waitForFunction(() => calls.length === 1);
      await page.evaluate(() => pending.shift()({ ok: true, sent: true, result: {
        model: 'jev-1.13.0', score: 0, hide: false, uncertain: false, contextSufficient: 1,
        categories: ['insult', 'threat', 'hate', 'harassment'].map(id => ({ id, normalized: 0, score: 0, risk: 0, confidence: 1 }))
      } }));
      await page.waitForFunction(() => Boolean(filter.getStats().autoPausedCode));
      assert.equal(await page.evaluate(() => filter.getStats().evaluated), 0);
      assert.equal(await original(1).isVisible(), false);
      assert.equal(await page.locator('#p1[data-nyan-masked]').count(), 0);
    });
    await check('only a proven unsent BUSY response is automatically retried', async () => {
      await setup(post(1), { response: 'busy-once' });
      await page.waitForSelector('#p1[data-nyan-masked]');
      assert.equal(await page.evaluate(() => calls.length), 2);
    });
    await check('search additions auto-score and DM navigation removes cover attributes', async () => {
      await setup(post(1, 'LOW'));
      await page.evaluate(() => { window.route = '/search?q=fiction'; filter.refresh(); });
      await page.waitForFunction(() => filter.getStats().evaluated === 1);
      await page.evaluate(html => document.querySelector('main > div').insertAdjacentHTML('beforeend', html), post(2));
      await page.waitForSelector('#p2[data-nyan-masked]');
      await page.evaluate(() => { window.route = '/i/chat/42'; filter.refresh(); });
      assert.equal(await page.locator('[data-nyan-ui],[data-nyan-holding],[data-nyan-screened],html[data-nyan-auto-cover]').count(), 0);
      assert.equal(await original(2).isVisible(), true);
    });
    await check('initial CSS covers unseen outer posts, not quote subtrees or DM, before refresh', async () => {
      await setup(post(1, 'LOW', { quote: true }), { ready: false });
      const visibility = await page.evaluate(html => {
        document.querySelector('main > div').insertAdjacentHTML('beforeend', html);
        return ['p8', 'p9'].map(id => getComputedStyle(document.querySelector(`#${id} > [data-testid="tweetText"]`)).visibility);
      }, post(8) + `<aside data-testid="DMDrawer">${post(9)}</aside>`);
      assert.deepEqual(visibility, ['hidden', 'visible']);
      await page.evaluate(() => filter.setAutoJudgeEnabled(false));
      assert.equal(await page.locator('#p1 article [data-testid="tweetText"]').isVisible(), true);
    });
    await check('no browser errors, real posts or HTTP requests', async () => {
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
    });
    console.log(`${count} automatic DOM checks passed. No real API calls.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
