(() => {
  'use strict';
  const POST = 'article[data-testid="tweet"]';
  const UI = '[data-nyan-ui]';
  const TEXT = '[data-testid="tweetText"]';
  const AUTHOR = '[data-testid="User-Name"]';
  const QUOTE = '[data-testid="quoteTweet"],[data-testid="quotedTweet"],[data-testid="tweetUnavailable"],[data-nyan-quote]';
  const EXCLUDED = '[data-nyan-excluded],aside,nav,form,[role="dialog"],[contenteditable="true"],[data-testid*="DM"],[data-testid*="message" i],[data-testid*="chat" i]';

  function candidates(root, mode) {
    const scopes = mode === 'demo' ? [root] : Array.from(root.querySelectorAll('[data-testid="primaryColumn"]'));
    const all = [...new Set(scopes.flatMap(scope => Array.from(scope.querySelectorAll(POST))))];
    const posts = all.filter(post => isCandidate(post, root, mode));
    return { posts, excluded: all.length - posts.length };
  }
  function isCandidate(post, root, mode) {
    return post.isConnected && root.contains(post) && post.matches(POST) && !post.closest(EXCLUDED) &&
      !post.closest('[hidden],[aria-hidden="true"]') &&
      (typeof post.checkVisibility !== 'function' || post.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) &&
      !post.parentElement?.closest(POST) && (mode === 'demo' || Boolean(post.closest('[data-testid="primaryColumn"]')));
  }
  function insideBoundary(node, boundaries) {
    return boundaries.some(boundary => boundary === node || boundary.contains(node));
  }
  function owned(post, selector, boundaries) {
    return Array.from(post.querySelectorAll(selector)).filter(node =>
      !node.closest(UI) && node.closest(POST) === post && !insideBoundary(node, boundaries));
  }
  function statusPath(node) {
    try {
      const url = new URL(node.getAttribute('href'), 'https://x.com');
      return url.origin === 'https://x.com' && /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+\/?$/.test(url.pathname) ? url.pathname : '';
    } catch { return ''; }
  }
  function parentPermalinks(post, boundaries) {
    // A status URL inside the author's text is not proof of the parent post ID.
    return owned(post, 'a[href]', boundaries).filter(node =>
      statusPath(node) && node.querySelector('time') && !node.closest(TEXT));
  }
  function ownText(node, boundaries) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.matches(UI) || insideBoundary(node, boundaries)) return '';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
    if (node.tagName === 'BR') return '\n';
    return Array.from(node.childNodes, child => ownText(child, boundaries)).join('');
  }
  function bodyVisible(post, text, boundaries) {
    // Inspect the page's styles, not our own pre-cover / waiting / cat mask.
    // While those rules are suspended, a separate clip keeps the entire post
    // covered. This scope must stay synchronous, with no clones or DOM moves.
    const inspecting = 'data-nyan-inspecting';
    const masked = post.getAttribute('data-nyan-masked') === 'true' || post.getAttribute('data-nyan-holding') === 'true';
    const preCovered = post.ownerDocument.documentElement.hasAttribute('data-nyan-auto-cover') && !post.hasAttribute('data-nyan-screened');
    const previous = post.getAttribute(inspecting);
    const suspendMask = masked || preCovered;
    if (suspendMask) post.setAttribute(inspecting, '');
    try {
      const view = post.ownerDocument.defaultView;
      if (!view || !post.isConnected) return false;
      const checked = new Map();
      function visible(node) {
        if (checked.has(node)) return checked.get(node);
        const style = view.getComputedStyle(node);
        const allowed = !node.hasAttribute('hidden') && node.getAttribute('aria-hidden')?.trim().toLowerCase() !== 'true' &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
          Number(style.opacity) !== 0 && style.contentVisibility !== 'hidden';
        checked.set(node, allowed);
        return allowed;
      }
      // A hidden wrapper can conceal an otherwise visible-looking tweetText.
      for (let ancestor = text; ancestor; ancestor = ancestor.parentElement) {
        if (!visible(ancestor)) return false;
      }
      function descendantsVisible(node) {
        if (node.matches(UI) || insideBoundary(node, boundaries)) return true;
        return visible(node) && Array.from(node.children).every(descendantsVisible);
      }
      // Do not silently drop hidden words and evaluate an altered partial post.
      return descendantsVisible(text);
    } catch {
      // An unavailable style/layout context cannot establish a readable body.
      return false;
    } finally {
      if (suspendMask) {
        if (previous === null) post.removeAttribute(inspecting);
        else post.setAttribute(inspecting, previous);
      }
    }
  }
  function structure(post) {
    const boundaries = Array.from(post.querySelectorAll(`${QUOTE},${POST}`)).filter(node => !node.closest(UI));
    const roleCards = Array.from(post.querySelectorAll('[role="link"]')).filter(node =>
      !node.closest(UI) && node.closest(POST) === post && !insideBoundary(node, boundaries) &&
      !node.closest(`${TEXT},${AUTHOR}`));
    const possibleCards = roleCards.filter(card => {
      if (!owned(post, TEXT, boundaries).some(text => card.contains(text))) return false;
      const hasStatus = [card, ...card.querySelectorAll('a[href]')].some(node =>
        node.hasAttribute('href') && statusPath(node) && !node.closest(TEXT));
      return hasStatus || Boolean(card.querySelector(AUTHOR) && card.querySelector('time'));
    });
    let ambiguousRoleCard = false;
    for (const card of possibleCards) {
      if (insideBoundary(card, boundaries)) continue;
      const withoutCard = [...boundaries, card];
      const outsideTexts = owned(post, TEXT, withoutCard);
      const outsideAuthors = owned(post, AUTHOR, withoutCard);
      const outsideIds = new Set(parentPermalinks(post, withoutCard).map(statusPath));
      // Recognize a separate embedded status only when a complete, unique parent
      // remains outside it. Never treat the first tweetText as the parent by order.
      if (outsideTexts.length === 1 && outsideAuthors.length === 1 && outsideIds.size === 1 &&
          !outsideTexts[0].contains(card)) boundaries.push(card);
      else ambiguousRoleCard = true;
    }
    const texts = owned(post, TEXT, boundaries);
    const authors = owned(post, AUTHOR, boundaries);
    const textContainsQuote = texts.some(text => boundaries.some(boundary => text.contains(boundary)));
    const isQuote = boundaries.length > 0 || possibleCards.length > 0 || texts.length > 1 || authors.length > 1;
    const bodyIsolated = texts.length === 1 && authors.length <= 1 && !textContainsQuote && !ambiguousRoleCard &&
      Boolean(ownText(texts[0], boundaries).trim());
    const hiddenBody = bodyIsolated && !bodyVisible(post, texts[0], boundaries);
    const permalinks = parentPermalinks(post, boundaries);
    const identities = [...new Set(permalinks.map(statusPath))];
    return { boundaries, texts, authors, isQuote, bodyIsolated, hiddenBody,
      identity: identities.length === 1 ? identities[0] : '',
      complete: bodyIsolated && !hiddenBody && authors.length === 1 && identities.length === 1 };
  }
  function author(post, info) {
    const nameBlock = info.authors.length === 1 ? info.authors[0] : null;
    if (!nameBlock) return '投稿者';
    const fixtureName = Array.from(nameBlock.querySelectorAll('[data-nyan-name]')).find(node => !insideBoundary(node, info.boundaries));
    const nameLink = Array.from(nameBlock.querySelectorAll('a')).find(a => {
      const text = ownText(a, info.boundaries).trim();
      return !insideBoundary(a, info.boundaries) && text && !text.startsWith('@') && !a.querySelector('time');
    });
    return ownText(fixtureName || nameLink || nameBlock, info.boundaries).trim().slice(0, 120) || '投稿者';
  }
  function restrictedKind(post, info) {
    // Deny signals only. Absence never means public. Never scan tweetText / page.innerText.
    const labels = owned(post, '[data-testid="User-Name"] [aria-label], [data-testid="User-Name"] [title], [data-testid="socialContext"] [aria-label]', info.boundaries)
      .flatMap(node => [node.getAttribute('aria-label'), node.getAttribute('title')]).filter(Boolean);
    labels.push(...owned(post, '[data-testid="socialContext"]', info.boundaries).map(node => ownText(node, info.boundaries).trim()));
    if (labels.some(label => /protected account|protected posts|非公開アカウント|ポストは非公開|非公開ポスト/i.test(label))) return 'protected';
    if (owned(post, '[data-testid="icon-lock"]', info.boundaries).length) return 'protected';
    if (labels.some(label => /subscribers? only|only subscribers|購読者限定|サブスクライバー限定|サブスクライブしているユーザーのみ/i.test(label))) return 'subscribers';
    if (labels.some(label => /limited audience|限定公開|circle|サークル/i.test(label))) return 'limited';
    return null;
  }
  function inspect(post, mode) {
    const info = structure(post);
    return {
      name: author(post, info),
      identity: info.identity || (mode === 'demo' ? post.dataset.nyanFixtureId || '' : ''),
      isQuote: info.isQuote,
      bodyIsolated: info.bodyIsolated,
      decision: NyanPolicy.decide({ mode, fixtureVisibility: post.dataset.nyanFixtureVisibility,
        restrictedKind: restrictedKind(post, info), untrustedQuote: info.isQuote && !info.bodyIsolated,
        complete: info.complete, bodyIsolated: info.bodyIsolated, hiddenBody: info.hiddenBody })
    };
  }
  function snapshot(post) {
    // Only called after the local structural exclusion check, never for DM/blocked posts.
    const info = structure(post);
    if (!info.bodyIsolated || info.hiddenBody || post.closest(EXCLUDED) || restrictedKind(post, info)) throw new Error('投稿者自身の本文を安全に取得できません。送信しません。');
    const text = ownText(info.texts[0], info.boundaries).trim();
    if (!text || text.length > 6000) throw new Error('本文が空、または6,000文字を超えています。送信しません。');
    return text;
  }
  globalThis.NyanAdapter = Object.freeze({ candidates, isCandidate, inspect, snapshot, postSelector: POST, uiSelector: UI });
})();
