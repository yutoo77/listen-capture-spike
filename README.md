# Listen / Capture — Audio Technical Spike v0.1

> 2026-10-17。**これは製品版ではなく、iPhoneの音声UXに関する技術検証**です。React・Django・AWSを構築する前に、ブラウザ標準APIの能力と実機の制約を確かめます。

## まず何ができる？

1. 同梱の英語デモ音声（約3分）または自分の音声ファイルを再生する。
2. 再生中に「メモを録音する」をタップすると、**その瞬間の再生時刻を先に確定**して一時停止する。
3. マイクの許可後に自分の声を録音し、終了すると **ブラウザ内の IndexedDB** に保存する。
4. 再生が許可されれば元の位置から自動再開し、拒否されれば再生ボタンで復帰する。
5. 保存した声をあとから再生・音声ファイルとして保存できる。元の資料位置に戻ることもできる。
6. 音声メモが不要な状況向けに、再生位置だけの「印」も保存できる。
7. 「技術検証・ログ」から使用可能なAPIとイベント時刻を確認し、ログをJSONとして持ち出せる。

**未対応**: PDF読込、文章の正確な読み上げ・文字起こし、クラウド保存、ユーザーアカウント、認証認可、イヤホンからの録音開始、画面ロック中のマイク制御、障害時の永続保証、AWS。これらが動くと主張するコードではありません。

### なぜ今回は React/TypeScript ではなく Vanilla JS？

今回の問いは `audio.play()` → `getUserMedia()` / `MediaRecorder` → IndexedDB → `audio.play()` という**ブラウザの挙動**です。フレームワークやBackendの問題と切り離し、再現性と原因追跡を優先しました。検証で確かめた振る舞いを、本体のReact/TypeScriptに移します。

## PCでの試し方

1. ZIPを展開して、`index.html` のあるフォルダを開く。
2. ターミナルから以下を実行する。

```bash
python -m http.server 8000
```

3. PCのブラウザで `http://localhost:8000/` を開く。`localhost` はマイクAPIを利用できる **secure contextの例外**です。
4. 「再生」→「メモを録音する」→マイク許可→5秒話す→「録音を終了する」→保存と再生復帰を確認。

※ `index.html` のダブルクリック（`file://`）はブラウザにより動作差が出るため、推奨しません。

## iPhoneのSafariでの試し方（HTTPSが必須）

マイクAPIは安全なコンテキストが原則です。**PCの `localhost` と iPhoneから見た `localhost` は別物**なので、PC側だけサーバーを起動してもiPhoneのマイク試験には不十分。いちばん簡単なのはGitHub Pagesでこの静的な試作品をHTTPS配信することです。

1. GitHubで新規の**テスト用リポジトリ**（例: `listen-capture-spike`）を作成。無料プランのPagesを使うなら通常は公開リポジトリが必要。
2. このフォルダの `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `assets/`, `.nojekyll` をそのリポジトリのルートへアップロード／pushする。
3. リポジトリの **Settings → Pages → Build and deployment** で **Deploy from a branch**, **main**, **/(root)** を設定。
4. 発行された `https://<GitHubユーザー名>.github.io/<リポジトリ名>/` をiPhoneのSafariで開く。
5. まずSafariでテスト。その後「共有 → ホーム画面に追加」でPWA相当の別動作を比較する。Manifest付きのホーム画面Webアプリが起動したら、Safariタブとの挙動の違いを確認。**Service Workerは含まないためオフライン動作はできません**。

**公開時の注意**: GitHub Pagesはサイト自体が公開されます。このリポジトリに講義資料・録音・個人情報・APIキーなどをコミットしないでください。ページ上で選ぶローカル音声ファイルと録音はネットワークへ送信されません。ただしブラウザ内IndexedDBも恒久保存を保証するものではありません。公共・共有端末ではテストしないでください。

GitHub Pages公式: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## 週末P0テスト（この順番で）

| テスト | 操作 | 成功なら何が分かる？ |
|---|---|---|
| P0-1 | iPhone Safariで再生 → 画面ロック → 解除 → 続きを再生 | 音声が画面ロックに耐える条件 |
| P0-2 | 再生 → メモ録音 → 停止 → 再生を5回 | 再生とマイク切替が安定するか |
| P0-3 | AirPods等を接続し同じことを試す | 入出力経路切替の問題有無 |
| P0-4 | 録音後に再読込 → メモを再生 | IndexedDBへの保存が成立するか |
| P0-5 | 同条件でホーム画面から起動 | Safariタブとの差 |
| P0-6 任意 | 「次の曲→印」実験を有効にしてイヤホン操作 | Media SessionイベントがiOSから届くか（届かなくても仕様上あり得る） |

必要なら20分以上の音声ファイルを自分で選んで再生時間のテストをしてください。同梱デモは約3分です。

### 計測してほしいこと

- Safariタブとホーム画面で、ロック中の**再生継続**と**再開**に違いはある？
- 本体マイク・Bluetoothイヤホンで、録音が無音／小音量／スピーカー漏れになることはある？
- 録音開始・終了時、予期しない再生位置のズレはある？
- **元の位置に戻れること**と**元音声ファイルを再度選ばなくていいこと**は別。ローカル音声ファイルは本体プロトタイプのDBに保存されない。
- `exportLog` でログをダウンロードして、画面ロック・録音切替時のイベントを比較。

テストシートは `TEST_PLAN.md`。

## コードを理解するための地図

| ファイル | 何をしているか |
|---|---|
| `index.html` | UIの意味構造と音声操作のボタン |
| `styles.css` | スマホファーストの最小UI |
| `app.js` → `beginRecording()` | 再生位置を先に保存、音声を停止、権限取得、録音開始 |
| `app.js` → `endRecording()` / `finalizeRecording()` | 録音を停止し、IndexedDB保存、可能なら再開 |
| `app.js` → `openDB()` / `dbTransaction()` | ブラウザ内データ保存。**Cloudではない** |
| `app.js` → `installMediaSession()` | 再生・巻き戻し・実験的な「次の曲」イベントの登録 |
| `app.js` → `renderMemos()` | 保存データを安全にテキスト表示して録音を再生 |

### 重要な設計判断

- **再生位置をマイク許可より先に記録**する。許可に時間がかかるので、後で参照位置がズレるのを防ぐ。
- `MediaRecorder.isTypeSupported()` で音声形式を選び、M4A固定などの仮定を置かない。
- 録音終了時はマイクのTrackを停止し、権限と音声経路を解放する。
- クラウドは使わない。録音はIndexedDB、録音音声のURLは`blob:`、選択元音声も`blob:` URL。**どちらも認可を伴う本番Storageではない**。
- 再生復帰がブラウザ側から拒否されたら利用者のタップで復帰する。API呼び出しの成功を当然視しない。
- メモは同じorigin内のブラウザに保存されるが、ブラウザによってデータが削除され得る。重要な録音はダウンロードしてバックアップする。

## 次の本体開発への移行

P0で主要なブラウザ挙動が分かったら、React/TypeScript UIとDjango/DRF APIを分け、PostgreSQL（ユーザー・資料版・録音参照位置・メモ）と、非公開Object Storage（実ファイル）を採用する。AWSは候補であって、P0段階ではサービス契約や課金は不要。

**最初のVertical Slice**: ログイン → テキスト資料登録 → 音声再生 → 録音 → 保存 → 元の位置に戻る → 自分のメモを確認。

### 参考資料

- MDN `getUserMedia` / secure context: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN `MediaRecorder.isTypeSupported`: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
- MDN `MediaSession.setActionHandler`: https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setActionHandler
- GitHub Pages HTTPS: https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
