(() => {
  'use strict';
  const reasons = Object.freeze({
    protected: '対象外：非公開の表示を検出',
    subscribers: '対象外：購読者限定の表示を検出',
    limited: '対象外：限定公開の表示を検出',
    unknown: '対象外：公開性を確認できません',
    candidate: '送信候補（公開性の確証なし・送信保留）',
    quote: '対象外：投稿者の本文と引用先を分離できません',
    hidden: '対象外：本文に非表示の要素を検出',
    public: '架空データで公開を明示（実際のXの証明ではありません）'
  });
  function supportedPath(path) {
    const pathname = String(path).split(/[?#]/, 1)[0];
    return /^\/(?:home|search)\/?$/.test(pathname) ||
      /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/\d+\/?$/.test(pathname);
  }
  function decide({ mode = 'live', fixtureVisibility, restrictedKind, untrustedQuote = false, complete = false, hiddenBody = false } = {}) {
    // Public fixtures are a test harness only. No DOM attribute grants live permission.
    let visibility = 'unknown';
    let reason = reasons.unknown;
    if (mode === 'demo' && fixtureVisibility === 'public') {
      visibility = 'public';
      reason = reasons.public;
    } else if (mode === 'live' && complete) {
      visibility = 'candidate';
      reason = reasons.candidate;
    }
    const restricted = restrictedKind || (mode === 'demo' ? fixtureVisibility : null);
    if (['protected', 'subscribers', 'limited'].includes(restricted)) {
      visibility = 'restricted';
      reason = reasons[restricted];
    } else if (untrustedQuote) {
      visibility = 'unknown';
      reason = reasons.quote;
    } else if (hiddenBody) {
      visibility = 'unknown';
      reason = reasons.hidden;
    }
    return Object.freeze({ visibility, reason, mask: false, canSend: false,
      eligibleForTest: visibility === 'candidate' || visibility === 'public' });
  }
  const cries = Object.freeze(['にゃーん', 'にゃん', 'にゃおーん', 'みゃー', 'にゃ〜', 'にゃにゃっ']);
  function cryFor(key) {
    let hash = 2166136261;
    for (const character of String(key)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
    return cries[hash % cries.length];
  }
  globalThis.NyanPolicy = Object.freeze({ supportedPath, decide, cryFor, cries });
})();
