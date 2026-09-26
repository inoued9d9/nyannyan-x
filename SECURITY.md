# セキュリティ上の問題の報告

このプロジェクトは評価版です。対応対象は原則として最新の `main` で、応答期限や継続的な保守を保証するものではありません。

APIキーの露出、意図しない外部送信、対象外コンテンツの送信、ページからの不正な拡張操作などを見つけた場合は、公開Issue・PR・コメントへ詳細を書かないでください。通常の表示不具合は、架空データだけでIssueに報告できます。

## 非公開で報告する方法

GitHub上で公開リポジトリが作成され、所有者が **Private vulnerability reporting** を有効にした場合は、リポジトリの **Security → Advisories → Report a vulnerability** から報告できます。

このファイルを追加しただけでは、GitHub側の機能は有効になりません。現時点で有効化済みとは主張していません。ボタンがない場合、公開Issueには脆弱性の内容を書かず、所有者に非公開窓口の設定だけを依頼してください。窓口が確認できるまで詳細や再現コードを公開しないでください。

報告にはバージョン、影響、架空データによる最小の再現手順、期待する動作を含めてください。非公開の報告であっても、実APIキー、`.env`、Cookie、ブラウザプロファイル、実投稿、鍵投稿、DM、実タイムラインのスクリーンショットは送らないでください。

認証情報が漏れた可能性がある場合は、利用者自身が該当サービスで失効・再発行してください。報告のために実キーを再掲する必要はありません。

## 所有者による公開時の設定

1. GitHubのリポジトリで **Settings** を開きます。
2. サイドバーの **Security and quality → Advanced Security** を開きます。
3. **Private vulnerability reporting** の **Enable** を選びます。
4. **Security → Advisories** に **Report a vulnerability** が表示されることを確認します。
5. 所有者がSecurity alertsなどの通知を受け取れる設定を確認します。

画面名や利用条件は変わる場合があります。[GitHub公式の設定手順](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)を参照してください。公開前の残作業は [公開準備](docs/publishing.md) に記載しています。
