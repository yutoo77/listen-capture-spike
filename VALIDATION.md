# 検証記録 — Listen / Capture

更新日：2026-10-17。静的な音声操作プロトタイプの検証記録です。**iPhone実機の再生・録音・画面ロック・Bluetoothは未検証です。**

## 入力と由来

- ユーザー提供：`listen-capture-codex-mobile-handoff.zip`
- ZIP SHA-256：`C6F48B9043C6EDC4DEB67266E90E851287513C153C7A298CB325767C30A975B1`
- 展開後のベースラインcommit：`c9c920b`（初回push前にGitHub noreplyメールへ変更したため、以前のローカルcommit `0fc21df` を置換）
- 本試作品は既存HTML・JavaScriptを引き継いで整備。実在利用者の録音・教材は含めません。

## 検証の種類と状態

| 種類 | 状態 | 証明できる範囲・限界 |
|---|---|---|
| ソース・構文・Manifest・アセット確認 | `npm run check` 成功 | ファイルの整合性。実際の録音品質は証明しない |
| Desktopブラウザ回帰試験 | Chromium 151.0.7922.34、16/16成功 | 擬似マイク等による操作・保存・状態遷移。iPhone固有の挙動は証明しない |
| 公開HTTPS・アセット到達確認 | 2026-10-17 08:11 JSTに成功 | 外部から取得できること。iPhoneでの音声操作は証明しない |
| iPhone Safari | 未検証 | 実機テストが必要 |
| ホーム画面版 | 未検証 | Safariとの差を実機で確認する |
| Bluetooth・ロック画面・割込み | 未検証 | 実機・実イヤホンが必要 |

公開URL：<https://yutoo77.github.io/listen-capture-spike/>

専用公開リポジトリ：[yutoo77/listen-capture-spike](https://github.com/yutoo77/listen-capture-spike)

公開コードcommit：`35e438a3365c7fa41edd4de193a8cf065f895737`

`app.js` SHA-256：`d7e3899092be75bb035c52f97121c3c7249852d511c5d5bde8a5361799c63842`

## 実施結果

- ソースチェック：`npm run check` 成功。
- Desktop回帰試験：`node tests/browser-regression.cjs`（`npm test`からも実行）。Chromium 151.0.7922.34、**16/16成功**。`pageerror` 0件、想定外リクエスト・外部送信 0件。
- Chromiumの`fake-device`／`fake-ui`を使用し、物理マイクは不使用。自動再生制限を無効化するオプションは付けていません。
- 録音Blobの再生、ダウンロードのbyte数一致、IndexedDB再読込、印・削除・元位置への復帰、録音中の操作制限、同名別内容ファイルの照合、ログへの情報漏出を検証。
- マイク拒否、自動再生拒否、録音Track終了、DBの`QuotaExceededError`は**注入した障害**です。回復分岐を確認した結果であり、実機上の自然発生障害を再現した主張ではありません。保存失敗した2件の救済ダウンロード保持と再保存も確認。
- 追加の回復試験は、①DB保存成功後の一覧DOM更新失敗で保存済みとして扱い再読込後も存在、②マイク準備キャンセル後に遅れて取得したstreamの全Trackを解放し次の録音が可能、③60秒の上限をテスト内だけ2秒へ加速し中断録音の保存・マイク解放・自動再開なし、の3件です。
- 390×844と1440×1000で横方向overflowなし。`artifacts/test-results/`のスクリーンショットを担当者とrootが目視確認。
- 初回は12件中11件成功。失敗1件はテスト内の`fetch(blob:)`を意図したCSPが拒否したもの。テストを実際のダウンロード経路の確認へ直し、13/13成功。回復試験3件の追加後に16/16成功。**この失敗のためにアプリのCSPは緩和していません。**
- [GitHub Actionsの品質チェック・公開run](https://github.com/yutoo77/listen-capture-spike/actions/runs/38979935117)が成功。Ubuntu上のChromium 151.0.7922.34でも16/16成功し、同一の`app.js`を配置しました。
- 公開先を別のHTTP検証で確認（2026-10-17 08:11 JST）。静的ファイル8件のGETはすべて200、配信bytesはcommit内と一致。デモMP3の`Range: bytes=0-1023`は206、`Content-Range: bytes 0-1023/1262300`を返しました。

再実行：`npm ci` → `npx playwright install chromium` → `npm run check` → `npm test`。環境によってはバンドル済みPlaywrightを`PLAYWRIGHT_MODULE`で指定できます。

## 現時点の境界

- クラウド保存、複数アカウント、認証認可、PDF取込、TTS、STTの検証ではありません。
- 擬似マイクでBlobが保存・再生できても、人の声の録音品質、Bluetoothの入力経路、iOSでの背景動作は未確認です。
- 未保存録音の復旧欄は、開いているページ内での再試行・ダウンロード用です。ページ終了・再読込・OS停止を越える永続保証ではありません。
- ローカル元音声の実データは永続保存しません。再読込後は同じファイルの再選択が必要です。
- ホーム画面追加は完全なオフライン動作やNative同等の背景権限を意味しません。

実機の結果は [TEST_PLAN.md](./TEST_PLAN.md) の条件とともに記録し、未検証欄を推測で埋めないでください。
