(() => {
  "use strict";

  const root = document.querySelector("#timeline");
  const toggle = document.querySelector("#filter-toggle");
  const stateLabel = document.querySelector("#filter-state");
  const announcement = document.querySelector("#announcement");
  let currentView = "home";
  let currentPath = "/home";
  let enabled = true;
  let addedCount = 0;
  let announcementTimer;
  let filter;

  // All text below is authored fixture data. No real posts are loaded or stored.
  const homeFixtures = [
    { name: "こもれび", handle: "@fictional_komorebi", avatar: "木", tone: "mint", visibility: "protected", badge: "鍵アカウントの例", text: "今日のことは、いつものメンバーだけに。\n小さな喫茶店で、のんびりした午後を過ごしました。", time: "2分" },
    { name: "澪", handle: "@fictional_mio", avatar: "澪", tone: "sky", visibility: "unknown", badge: "公開性不明の例", text: "この投稿の公開範囲は、画面から確認できません。\n公開の根拠がないため、保護対象として扱います。", time: "5分" },
    { name: "珈琲日和", handle: "@fictional_coffee", avatar: "珈", tone: "sand", visibility: "public", badge: "公開の架空サンプル", text: "朝の一杯を、窓辺で。\n雨上がりの空気と深煎りの香りが、よく似合う。", time: "8分", counts: ["2", "1", "12"] },
    { name: "星のアトリエ", handle: "@fictional_atelier", avatar: "星", tone: "lavender", visibility: "subscribers", badge: "限定公開の例", text: "メンバー限定の制作ノートです。\n今週のスケッチと、次の展示のアイデアをまとめました。", time: "12分" },
    { name: "散歩の記録", handle: "@fictional_walk", avatar: "歩", tone: "mint", visibility: "public", badge: "限定公開の引用あり", text: "引用部分に限定公開の情報が含まれる例です。", time: "18分", quote: { name: "こもれび", handle: "@fictional_komorebi", visibility: "protected", badge: "鍵アカウントの引用例", text: "親しい人だけに共有していた、週末の予定です。" } }
  ];

  const replyFixtures = [
    { name: "珈琲日和", handle: "@fictional_coffee", avatar: "珈", tone: "sand", visibility: "public", badge: "公開の架空サンプル", text: "最近読んでよかった本、ありますか？\n雨の日のおともを探しています。", time: "20分", counts: ["2", "0", "8"] },
    { name: "本と休日", handle: "@fictional_books", avatar: "本", tone: "lavender", visibility: "protected", badge: "鍵アカウントの返信例", text: "私の読書メモを送ります。\nこの話はフォロワーさんの間だけで。", time: "12分", reply: "珈琲日和への架空の返信" },
    { name: "凪", handle: "@fictional_nagi", avatar: "凪", tone: "mint", visibility: "unknown", badge: "公開性不明の返信例", text: "今読んでいる短編集、きっと好きだと思う。", time: "7分", reply: "珈琲日和への架空の返信" },
    { name: "青い栞", handle: "@fictional_shiori", avatar: "栞", tone: "sky", visibility: "public", badge: "公開の架空サンプル", text: "旅のエッセイがおすすめです。\n温かい飲み物と一緒に、ゆっくり読める一冊。", time: "3分", reply: "珈琲日和への架空の返信", counts: ["0", "0", "3"] }
  ];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function identity(fixture) {
    const group = element("div", "post-identity");
    group.setAttribute("data-testid", "User-Name");
    const name = element("a", "");
    name.href = "#";
    name.setAttribute("data-nyan-name", "");
    name.append(element("span", "", fixture.name));
    name.addEventListener("click", event => event.preventDefault());
    group.append(name, element("span", "handle", fixture.handle));
    return group;
  }

  function fixtureBadge(fixture) {
    return element("span", `fixture-badge ${fixture.visibility}`, fixture.badge);
  }

  function createPost(fixture, index) {
    const article = element("article", "demo-post");
    article.setAttribute("data-testid", "tweet");
    article.setAttribute("data-nyan-fixture-visibility", fixture.visibility);
    article.setAttribute("data-nyan-fixture-id", `${currentView}-${index}`);
    const header = element("header", "post-header");
    const avatar = element("span", `avatar avatar-${fixture.tone}`, fixture.avatar);
    avatar.setAttribute("aria-hidden", "true");
    const person = element("div", "");
    person.append(identity(fixture), element("div", "post-meta", `${fixture.time} · 架空の投稿`));
    header.append(avatar, person, fixtureBadge(fixture));
    article.append(header);
    if (fixture.reply) article.append(element("p", "reply-context", fixture.reply));
    const text = element("div", "", fixture.text);
    text.setAttribute("data-testid", "tweetText");
    article.append(text);
    if (fixture.quote) {
      const quote = element("div", "quote-post");
      quote.setAttribute("data-nyan-quote", "");
      quote.setAttribute("data-nyan-fixture-visibility", fixture.quote.visibility);
      quote.append(fixtureBadge(fixture.quote), identity(fixture.quote));
      const quoteText = element("div", "", fixture.quote.text);
      quoteText.setAttribute("data-testid", "tweetText");
      quote.append(quoteText);
      article.append(quote);
    }
    const actions = element("div", "post-actions");
    actions.setAttribute("aria-label", "架空の反応数。操作はできません。");
    const counts = fixture.counts || ["0", "0", "0"];
    ["↩", "↻", "♡"].forEach((symbol, i) => {
      const item = element("span", "");
      const icon = element("span", "action-symbol", symbol);
      icon.setAttribute("aria-hidden", "true");
      item.append(icon, element("span", "", counts[i]));
      actions.append(item);
    });
    article.append(actions);
    return article;
  }

  function announce(message) {
    window.clearTimeout(announcementTimer);
    announcement.textContent = message;
    announcement.classList.add("visible");
    announcementTimer = window.setTimeout(() => announcement.classList.remove("visible"), 2800);
  }

  function updateStats(stats) {
    ["masked", "restricted", "unknown", "public"].forEach(key => {
      const count = Number(stats[key]);
      document.querySelector(`#stat-${key}`).textContent = String(Number.isFinite(count) ? count : 0);
    });
  }

  function updateControls() {
    toggle.setAttribute("aria-pressed", String(enabled));
    document.querySelector("#toggle-label").textContent = `フィルター ${enabled ? "ON" : "OFF"}`;
    stateLabel.textContent = currentView === "dm" ? "読み取り・置換対象外" : enabled ? "フィルター稼働中" : "原文を表示中";
    stateLabel.classList.toggle("off", !enabled || currentView === "dm");
    document.querySelector("#remask").disabled = !enabled || currentView === "dm";
    document.querySelector("#add-post").disabled = currentView === "dm";
  }

  function changeView(view, notify = true) {
    currentView = view;
    currentPath = view === "dm" ? "/messages" : view === "replies" ? "/demo_coffee/status/123456789" : view === "search" ? "/search?q=sample" : "/home";
    if (filter) filter.stop();
    addedCount = 0;
    root.replaceChildren();
    root.hidden = view === "dm";
    document.querySelector("#dm-view").hidden = view !== "dm";
    document.querySelector("#feed-title").textContent = { home: "ホームタイムライン", replies: "投稿とリプライ", search: "検索結果（架空）", dm: "メッセージ · 対象外" }[view];
    document.querySelectorAll("[data-view]").forEach(button => {
      const selected = button.dataset.view === view;
      button.classList.toggle("selected", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (view !== "dm") {
      const fixtures = view === "replies" ? replyFixtures : homeFixtures;
      fixtures.forEach((fixture, index) => root.append(createPost(fixture, index)));
    }
    if (filter && enabled) filter.start();
    if (filter && !enabled) updateStats(filter.getStats());
    updateControls();
    if (notify) announce(view === "dm" ? "DM画面では、本文の読み取り・置換を行いません。" : `${view === "home" ? "ホーム" : view === "search" ? "検索" : "リプライ"}の架空サンプルに切り替えました。`);
  }

  changeView("home", false);
  if (!window.NyanFilter || typeof window.NyanFilter.create !== "function") {
    enabled = false;
    toggle.disabled = true;
    document.querySelector("#remask").disabled = true;
    document.querySelector("#add-post").disabled = true;
    stateLabel.textContent = "フィルターを読み込めませんでした";
    announce("フィルターのファイルを読み込めませんでした。拡張の配置を確認してください。");
    return;
  }
  filter = window.NyanFilter.create({ root, mode: "demo", getPath: () => currentPath, onChange: updateStats });
  filter.start();

  toggle.addEventListener("click", () => {
    enabled = !enabled;
    if (enabled) filter.start();
    else filter.stop();
    updateControls();
    updateStats(filter.getStats());
    announce(enabled ? "ローカルフィルターを有効にしました。" : "フィルターを停止し、架空の原文に戻しました。");
  });
  document.querySelector("#remask").addEventListener("click", () => {
    filter.resetTests();
    announce("表示テストを解除して原文に戻しました。");
  });
  document.querySelector("#add-post").addEventListener("click", () => {
    addedCount += 1;
    const fixture = { name: `昼寝日和 ${addedCount}`, handle: "@fictional_hirune", avatar: "昼", tone: "sand", visibility: "unknown", badge: "動的追加・公開性不明", text: "スクロールで新しく読み込まれた投稿を想定した、日本語の架空サンプルです。", time: "いま" };
    root.prepend(createPost(fixture, `added-${addedCount}`));
    if (enabled) filter.refresh();
    announce("公開性不明の架空投稿を追加しました。");
  });
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => changeView(button.dataset.view)));
})();
