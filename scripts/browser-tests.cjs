// Authored local fixtures only. Never visits X or a real API.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.NYAN_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
function post(id, visibility, body = '架空の日本語本文', extra = '', complete = true) {
  const marker = visibility === 'protected' ? '<span aria-label="Protected account">🔒</span>' : '';
  const sub = visibility === 'subscribers' ? '<div data-testid="socialContext">Subscribers only</div>' : '';
  const time = complete ? `<a href="/sample/status/${100 + id.length}"><time>1分</time></a>` : '<time>1分</time>';
  return `<article data-testid="tweet" id="${id}" data-nyan-fixture-id="${id}" data-nyan-fixture-visibility="${visibility}">${sub}<header><div data-testid="User-Name"><a data-nyan-name href="/sample">${id}さん</a>${marker}<span>@fictional</span></div>${time}</header><div data-testid="tweetText">${body}</div>${extra}</article>`;
}
async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.NYAN_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light', serviceWorkers: 'block' });
  page.setDefaultTimeout(5000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.route('**/*', route => /^https?:/.test(route.request().url()) ? route.abort() : route.continue());
  let passed = 0;
  async function check(label, action) { await action(); passed++; console.log(`PASS ${label}`); }
  const source = id => page.locator(`#${id} > [data-testid="tweetText"]`);
  const ui = id => page.locator(`#${id} > [data-nyan-ui]`);
  const send = id => page.locator(`#${id} > [data-nyan-ui] [data-nyan-send]`);
  const testButton = id => ui(id).getByRole('button', { name: '置換をテスト', exact: true });
  async function setup(mode = 'demo', options = {}) {
    await page.evaluate(() => window.testFilter?.stop());
    await page.setContent(`<main><div data-testid="primaryColumn">${post('public', 'public')}${post('private', 'protected', '秘密の架空本文')}${post('unknown', 'unknown')}${post('incomplete', 'unknown', '文脈不明の架空本文', '', false)}${post('sub', 'subscribers')}${post('quote', 'public', '引用のある架空投稿', '<div data-nyan-quote data-nyan-fixture-visibility="protected"><div data-testid="tweetText">架空の非公開引用</div></div>')}<aside data-nyan-excluded="dm">${post('dm', 'protected', '架空DM')}</aside><div role="dialog">${post('dialog', 'unknown')}</div></div></main>`);
    for (const script of ['policy.js', 'jev-core.js', 'adapter.js', 'filter.js']) await page.addScriptTag({ path: path.join(extension, script) });
    await page.addStyleTag({ path: path.join(extension, 'filter.css') });
    await page.evaluate(({ mode, options }) => {
      window.testPath = options.path || '/home';
      window.testCalls = [];
      window.testConfirms = [];
      window.testResponseMode = 'success';
      window.testConfirmed = options.confirm !== false;
      window.testPending = [];
      window.makeResult = (probabilities = [0, 0, 0, 1], confidence = 1) => {
        const answer = values => ({ type: 'score', score: values.reduce((sum, probability, level) => sum + probability * level, 0),
          confidence, probabilities: Object.fromEntries(values.map((probability, level) => [String(level), probability])) });
        const answers = { discomfort: answer(probabilities) };
        return NyanJevCore.parseResponse({ model: 'jev-1.13.0', answers });
      };
      window.testResult = makeResult();
      const onEvaluate = options.evaluator ? async input => {
        testCalls.push(input);
        if (testResponseMode === 'pending') return new Promise(resolve => testPending.push(resolve));
        if (testResponseMode === 'throw') throw new Error('raw-private-error');
        if (testResponseMode === 'failure') return { ok: false, sent: false, error: 'raw-private-error' };
        return { ok: true, sent: true, result: testResult };
      } : undefined;
      window.testFilter = NyanFilter.create({ root: document, mode, getPath: () => testPath, onEvaluate,
        confirmSend: message => { testConfirms.push(message); return testConfirmed; } });
      // Existing restoration checks explicitly opt in. Default tests omit this setting.
      if (options.allowReveal !== false) testFilter.setAllowReveal(true);
      if (!options.defaultControls) testFilter.setShowTestControls(true);
      if (options.ready) testFilter.setJevReady(true);
      testFilter.start();
    }, { mode, options });
  }
  try {
    await setup('live', { evaluator: true, ready: true, allowReveal: false });
    await check('hidden body, ancestor and descendant content is excluded and cannot be snapshotted', async () => {
      const results = await page.evaluate(() => {
        const cases = [
          ['hidden', 'hidden', ''], ['aria-hidden', 'aria-hidden', 'true'],
          ['display', 'style', 'display:none'], ['visibility', 'style', 'visibility:hidden'],
          ['opacity', 'style', 'opacity:0'], ['content-visibility', 'style', 'content-visibility:hidden']
        ];
        const rows = [];
        for (const [name, attribute, value] of cases) {
          for (const position of ['body', 'ancestor', 'descendant', 'post', 'outside-ancestor']) {
            const item = document.getElementById('public').cloneNode(true);
            item.id = `hidden-${name}-${position}`;
            item.querySelectorAll('[data-nyan-ui]').forEach(node => node.remove());
            const body = item.querySelector('[data-testid="tweetText"]');
            body.innerHTML = 'VISIBLE FIXTURE <span>HIDDEN FIXTURE DO NOT SEND</span>';
            let target = body, host = item;
            if (position === 'ancestor') {
              target = document.createElement('div'); body.replaceWith(target); target.append(body);
            } else if (position === 'descendant') target = body.querySelector('span');
            else if (position === 'post') target = item;
            else if (position === 'outside-ancestor') {
              target = document.createElement('div'); target.append(item); host = target;
            }
            target.setAttribute(attribute, value);
            document.querySelector('[data-testid="primaryColumn"]').append(host);
            const candidate = NyanAdapter.isCandidate(item, document, 'live') &&
              NyanAdapter.inspect(item, 'live').decision.eligibleForTest;
            let snapshotRejected = false;
            try { NyanAdapter.snapshot(item); } catch { snapshotRejected = true; }
            rows.push({ name, position, candidate, snapshotRejected });
            host.remove();
          }
        }
        return rows;
      });
      assert.equal(results.length, 30);
      for (const { name, position, candidate, snapshotRejected } of results) {
        assert.equal(candidate, false, `${name} ${position} must not be eligible`);
        assert.equal(snapshotRejected, true, `${name} ${position} must reject extraction`);
      }
      assert.equal(await page.evaluate(() => testCalls.length), 0);
    });
    await check('CSS-class hiding and hidden image alt text cannot enter the body payload', async () => {
      const results = await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '.fixture-hidden-text { display:none }'; document.head.append(style);
        const item = document.getElementById('public');
        const body = item.querySelector('[data-testid="tweetText"]');
        const original = body.innerHTML;
        const cases = ['VISIBLE <span class="fixture-hidden-text">HIDDEN FIXTURE</span>',
          'VISIBLE <img hidden alt="HIDDEN FIXTURE ALT">'];
        const results = cases.map(markup => {
          body.innerHTML = markup;
          let rejected = false;
          try { NyanAdapter.snapshot(item); } catch { rejected = true; }
          return { eligible: NyanAdapter.inspect(item, 'live').decision.eligibleForTest, rejected };
        });
        body.innerHTML = original; style.remove();
        return results;
      });
      assert.deepEqual(results, [{ eligible: false, rejected: true }, { eligible: false, rejected: true }]);
    });
    await setup('live', { defaultControls: true });
    await check('normal X mode hides test buttons and keeps diagnostics below a flex-row post', async () => {
      assert.equal(await testButton('public').count(), 0);
      await page.evaluate(() => {
        const post = document.getElementById('public');
        const original = document.createElement('div'); original.id = 'source-wrapper';
        for (const child of [...post.children]) if (!child.hasAttribute('data-nyan-ui')) original.append(child);
        post.prepend(original);
        post.style.cssText = 'display:flex;flex-direction:row;width:500px';
        original.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';
        original.querySelector('[data-testid="tweetText"]').style.height = '300px';
      });
      const contentBox = await page.locator('#source-wrapper').boundingBox();
      const diagnosticBox = await ui('public').boundingBox();
      assert.equal(contentBox.width, 500);
      assert.equal(diagnosticBox.width, 500);
      assert.ok(diagnosticBox.y >= contentBox.y + contentBox.height);
      assert.ok(diagnosticBox.height <= 24);
      await page.evaluate(() => testFilter.stop());
      assert.equal(await page.locator('[data-nyan-attached]').count(), 0);
    });
    await setup();
    await check('default preserves originals with unjudged diagnostics', async () => {
      assert.equal(await page.locator('[data-nyan-masked]').count(), 0);
      for (const id of ['public', 'private', 'unknown', 'incomplete', 'sub', 'quote']) {
        assert.equal(await source(id).isVisible(), true);
        assert.match(await ui(id).innerText(), /未判定/);
      }
    });
    await check('restricted and unknown have no test action; isolated quote commentary is eligible; DM stays untouched', async () => {
      for (const id of ['private', 'unknown', 'incomplete', 'sub']) assert.equal(await ui(id).locator('button').count(), 0);
      assert.equal(await testButton('quote').count(), 1);
      for (const id of ['dm', 'dialog']) assert.equal(await page.locator(`#${id} [data-nyan-ui]`).count(), 0);
      assert.equal(await source('dm').innerText(), '架空DM');
    });
    await check('synthetic high result shows cat, compact test label, full title and stable cry', async () => {
      await testButton('public').click();
      assert.equal(await ui('public').locator('.nyan-author').innerText(), 'ねこ');
      const cry = await ui('public').locator('.nyan-message').innerText();
      assert.ok(await page.evaluate(value => NyanPolicy.cries.includes(value), cry));
      assert.equal(await source('public').isVisible(), false);
      assert.equal(await ui('public').locator('.nyan-reason').innerText(), 'テスト');
      assert.match(await ui('public').locator('.nyan-reason').getAttribute('title'), /実際の判定は未実施/);
      await ui('public').getByRole('button', { name: '原文に戻す' }).click();
      assert.equal(await source('public').isVisible(), true);
      await testButton('public').click();
      assert.equal(await ui('public').locator('.nyan-message').innerText(), cry);
    });
    await check('mock mode filters only candidates and timestamp updates preserve reveal', async () => {
      await page.evaluate(() => testFilter.setMockMode(true));
      assert.equal(await page.locator('[data-nyan-masked]').count(), 2);
      await ui('public').getByRole('button', { name: '原文に戻す' }).click();
      await page.evaluate(() => document.querySelector('#public time').textContent = '2分');
      assert.equal(await source('public').isVisible(), true);
      await page.evaluate(() => testFilter.setMockMode(false));
    });
    await check('new unknown posts stay visible with diagnostics', async () => {
      await page.evaluate(html => document.querySelector('[data-testid="primaryColumn"]').insertAdjacentHTML('beforeend', html), post('new', 'unknown'));
      await page.waitForSelector('#new > [data-nyan-ui]');
      assert.equal(await source('new').isVisible(), true);
    });
    await check('virtualized body and identity replacement clears synthetic test', async () => {
      await testButton('public').click();
      await page.evaluate(() => {
        document.querySelector('#public [data-testid="tweetText"]').textContent = '別の架空本文';
        document.querySelector('#public a[href*="/status/"]').setAttribute('href', '/sample/status/999');
      });
      await page.waitForFunction(() => !document.querySelector('#public').hasAttribute('data-nyan-masked'));
    });
    await check('removed diagnostic repairs without observer loop', async () => {
      await page.evaluate(() => document.querySelector('#private > [data-nyan-ui]').remove());
      await page.waitForSelector('#private > [data-nyan-ui]');
      assert.equal(await ui('private').count(), 1);
    });
    await check('SPA DM route removes all diagnostics and filtering', async () => {
      await page.evaluate(() => { testPath = '/i/chat/123'; });
      await page.waitForFunction(() => !document.querySelector('[data-nyan-ui]'));
      await page.evaluate(() => { testPath = '/alice/status/123'; });
      await page.waitForSelector('#private > [data-nyan-ui]');
    });
    await check('stop restores source DOM', async () => {
      await page.evaluate(() => { testFilter.setMockMode(true); testFilter.stop(); });
      assert.equal(await page.locator('[data-nyan-ui],[data-nyan-masked]').count(), 0);
      assert.equal(await page.locator('#private [data-nyan-name]').innerText(), 'privateさん');
    });
    await setup('live');
    await check('live candidates are tentative; protected/subscribers/incomplete excluded', async () => {
      assert.match(await ui('public').innerText(), /送信候補.*確証なし/);
      for (const id of ['private', 'sub', 'incomplete']) assert.equal(await ui(id).locator('button').count(), 0);
      assert.equal(await testButton('quote').count(), 1);
      assert.equal(await page.evaluate(() => testFilter.getStats().sent), 0);
    });
    await check('moving post into DM or changing role removes diagnostics', async () => {
      await page.evaluate(() => document.querySelector('aside').append(document.getElementById('unknown')));
      await page.waitForFunction(() => !document.querySelector('#unknown > [data-nyan-ui]'));
      await page.evaluate(() => document.getElementById('public').setAttribute('role', 'dialog'));
      await page.waitForFunction(() => !document.querySelector('#public > [data-nyan-ui]'));
    });
    await setup('live', { path: '/search?q=cat&f=live' });
    await check('search query changes reset tests; added search posts process; DM exits', async () => {
      await testButton('public').click();
      await page.evaluate(() => { testPath = '/search?q=coffee&f=live'; });
      await page.waitForFunction(() => !document.querySelector('#public').hasAttribute('data-nyan-masked'));
      await page.evaluate(html => document.querySelector('[data-testid="primaryColumn"]').insertAdjacentHTML('beforeend', html), post('searchnew', 'public'));
      await page.waitForSelector('#searchnew > [data-nyan-ui]');
      await testButton('searchnew').click();
      assert.equal(await source('searchnew').isVisible(), false);
      await page.evaluate(() => { testPath = '/messages/123'; });
      await page.waitForFunction(() => !document.querySelector('[data-nyan-ui]'));
      assert.equal(await source('searchnew').isVisible(), true);
    });
    await setup('demo', { allowReveal: false });
    await check('default reveal off rejects card click; ON restores and OFF rehides', async () => {
      assert.equal(await page.evaluate(() => testFilter.getStats().allowReveal), false);
      await page.evaluate(() => testFilter.setMockMode(true));
      assert.equal(await ui('public').locator('button').count(), 0);
      await ui('public').click();
      assert.equal(await source('public').isVisible(), false);
      await page.evaluate(() => testFilter.setAllowReveal(true));
      await ui('public').getByRole('button', { name: '原文に戻す' }).click();
      assert.equal(await source('public').isVisible(), true);
      await page.evaluate(() => testFilter.setAllowReveal(false));
      assert.equal(await source('public').isVisible(), false);
      assert.equal(await ui('public').locator('button').count(), 0);
    });
    await check('compact card is at most 48px high at 360px width', async () => {
      await page.evaluate(() => { document.querySelector('main').style.width = '360px'; });
      for (const reveal of [false, true]) {
        await page.evaluate(value => testFilter.setAllowReveal(value), reveal);
        const box = await ui('public').boundingBox();
        assert.equal(box.width, 360);
        assert.ok(box.height <= 48, `height ${box.height}px, reveal=${reveal}`);
      }
    });
    await setup('live', { evaluator: true, ready: true, allowReveal: false });
    await check('synthetic click never triggers confirmation or evaluation', async () => {
      await send('public').dispatchEvent('click');
      assert.equal(await page.evaluate(() => testConfirms.length), 0);
      assert.equal(await page.evaluate(() => testCalls.length), 0);
    });
    await check('unready, declined, protected, unknown and DM cannot send', async () => {
      for (const id of ['private', 'sub', 'incomplete', 'dm', 'dialog']) assert.equal(await send(id).count(), 0);
      await page.evaluate(() => testFilter.setJevReady(false));
      assert.equal(await send('public').count(), 0);
      await page.evaluate(() => { testFilter.setJevReady(true); testConfirmed = false; });
      await send('public').click();
      assert.equal(await page.evaluate(() => testCalls.length), 0);
      assert.equal(await page.evaluate(() => testConfirms.length), 1);
    });
    await check('trusted click plus confirmation sends one fixture body and applies parsed numeric result', async () => {
      await page.evaluate(() => { testConfirmed = true; });
      await send('public').click();
      await page.waitForSelector('#public[data-nyan-masked]');
      assert.equal(await page.evaluate(() => testCalls.length), 1);
      assert.deepEqual(await page.evaluate(() => Object.keys(testCalls[0]).sort()), ['isQuote', 'outerBodyOnly', 'postId', 'publicConfirmed', 'signal', 'text', 'visibility']);
      assert.equal(await page.evaluate(() => testCalls[0].text), '架空の日本語本文');
      assert.equal(await page.evaluate(() => testCalls[0].publicConfirmed), true);
      assert.equal(await ui('public').locator('.nyan-reason').innerText(), 'Jev 100');
      assert.equal(await page.evaluate(() => testFilter.getStats().sent), 1);
      assert.equal(await ui('public').locator('button').count(), 0);
    });
    await check('timestamps preserve numeric result and revealed state without new evaluation', async () => {
      await page.evaluate(() => { document.querySelector('#public time').textContent = '3分'; });
      assert.equal(await source('public').isVisible(), false);
      assert.equal(await page.evaluate(() => testFilter.getStats().evaluated), 1);
      await page.evaluate(() => testFilter.setAllowReveal(true));
      await ui('public').getByRole('button', { name: '原文に戻す' }).click();
      await page.evaluate(() => { document.querySelector('#public time').textContent = '4分'; });
      assert.equal(await source('public').isVisible(), true);
      assert.match(await ui('public').innerText(), /Jev判定済.*原文を表示中/);
      assert.equal(await page.evaluate(() => testCalls.length), 1);
      await page.evaluate(() => testFilter.setAllowReveal(false));
      assert.equal(await source('public').isVisible(), false);
    });
    await setup('live', { evaluator: true, ready: true, allowReveal: false });
    await check('threshold changes reuse the single discomfort score without another send', async () => {
      await page.evaluate(() => { testResult = makeResult([0.1, 0, 0.9, 0]); });
      await page.evaluate(() => testFilter.setScoreThreshold(65));
      await send('public').click();
      await page.waitForFunction(() => testFilter.getStats().evaluated === 1);
      assert.equal(await source('public').isVisible(), true);
      await page.evaluate(() => testFilter.setScoreThreshold(0));
      assert.equal(await source('public').isVisible(), false);
      await page.evaluate(() => testFilter.setScoreThreshold(65));
      assert.equal(await source('public').isVisible(), true);
      await page.evaluate(() => testFilter.setScoreThreshold(100));
      assert.equal(await source('public').isVisible(), true);
      assert.equal(await page.evaluate(() => testCalls.length), 1);
      assert.equal(await page.evaluate(() => testFilter.getStats().scoreThreshold), 100);
    });
    await setup('live', { evaluator: true, ready: true, allowReveal: false });
    await check('short text and low confidence still use only the discomfort threshold', async () => {
      await page.evaluate(() => {
        document.querySelector('#public > [data-testid="tweetText"]').textContent = '嫌い。';
        // Former confidence (<.5) and attack-probability (<.9) gates must not apply.
        testResult = makeResult([0.11, 0, 0, 0.89], 0.01);
      });
      await send('public').click();
      await page.waitForSelector('#public[data-nyan-masked]');
      assert.equal(await page.evaluate(() => testCalls[0].text), '嫌い。');
      assert.equal(await ui('public').locator('.nyan-reason').innerText(), 'Jev 89');
      await page.evaluate(() => testFilter.setScoreThreshold(90));
      assert.equal(await source('public').isVisible(), true);
      await page.evaluate(() => testFilter.setScoreThreshold(89));
      assert.equal(await source('public').isVisible(), false);
      assert.equal(await page.evaluate(() => testCalls.length), 1);
    });
    for (const change of ['body', 'identity', 'privacy', 'quote', 'dm-route', 'dm-move', 'disabled']) {
      await setup('live', { evaluator: true, ready: true, allowReveal: false });
      await check(`pending ${change} change aborts and rejects stale result`, async () => {
        await page.evaluate(() => { testResponseMode = 'pending'; });
        await send('public').click();
        await page.waitForFunction(() => testCalls.length === 1 && testPending.length === 1);
        await page.evaluate(change => {
          const post = document.querySelector('#public');
          if (change === 'body') post.querySelector('[data-testid="tweetText"]').textContent = '別の架空本文';
          if (change === 'identity') post.querySelector('a[href*="/status/"]').setAttribute('href', '/sample/status/99999');
          if (change === 'privacy') {
            const marker = document.createElement('span'); marker.setAttribute('aria-label', 'Protected account');
            post.querySelector('[data-testid="User-Name"]').append(marker);
          }
          if (change === 'quote') { const quote = document.createElement('div'); quote.setAttribute('data-testid', 'quoteTweet'); post.append(quote); }
          if (change === 'dm-route') testPath = '/i/chat/123';
          if (change === 'dm-move') document.querySelector('aside').append(post);
          if (change === 'disabled') testFilter.setJevReady(false);
        }, change);
        await page.waitForFunction(() => testCalls[0].signal.aborted);
        await page.evaluate(() => testPending.shift()({ ok: true, sent: true, result: makeResult() }));
        await page.waitForFunction(() => testFilter.getStats().sent === 1);
        assert.equal(await source('public').isVisible(), true);
        assert.equal(await page.evaluate(() => testFilter.getStats().evaluated), 0);
        assert.equal(await page.locator('#public[data-nyan-masked]').count(), 0);
      });
    }
    for (const responseMode of ['failure', 'throw']) {
      await setup('live', { evaluator: true, ready: true, allowReveal: false });
      await check(`${responseMode} keeps original and unjudged diagnostic without raw errors`, async () => {
        await page.evaluate(value => { testResponseMode = value; }, responseMode);
        await send('public').click();
        await page.waitForFunction(() => document.querySelector('#public > [data-nyan-ui]').textContent.includes('判定に失敗'));
        assert.equal(await source('public').isVisible(), true);
        const text = await ui('public').innerText();
        assert.match(text, /未判定/);
        assert.equal(text.includes('raw-private-error'), false);
        assert.equal(await page.evaluate(() => testFilter.getStats().evaluated), 0);
      });
    }
    await page.evaluate(() => testFilter.stop());
    await page.goto(pathToFileURL(path.join(extension, 'demo.html')).href);
    await page.waitForSelector('[data-nyan-ui]');
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts', 'demo-original.png'), fullPage: true });
    await page.locator('[data-nyan-ui] button').first().click();
    await page.screenshot({ path: path.join(root, 'artifacts', 'demo-desktop.png'), fullPage: true });
    await check('demo reveal default stays off; reset, reply and DM switches work', async () => {
      assert.equal(await page.locator('[data-nyan-masked] [data-nyan-ui] button').count(), 0);
      await page.locator('#remask').click();
      assert.equal(await page.locator('[data-nyan-masked]').count(), 0);
      await page.locator('[data-view="replies"]').click();
      await page.waitForSelector('[data-nyan-ui]');
      await page.locator('[data-view="dm"]').click();
      assert.equal(await page.locator('[data-nyan-ui]').count(), 0);
    });
    await check('no script errors or external requests', async () => { assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
    console.log(`${passed} browser checks passed. Screenshots in artifacts/.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
