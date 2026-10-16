# Listen / Capture — Audio Technical Spike

2026-10-17。iPhoneで「音声を聴く → 一時停止して声でメモ → 元の位置から聴く」が成立するかを確かめる、HTML・CSS・JavaScriptの静的な試作品です。

**iPhoneで開く：<https://yutoo77.github.io/listen-capture-spike/>**

2026-10-17 08:11 JSTに公開HTTPSと配信ファイルを確認済み。iPhoneの音声操作は実機でこれから確認します。

専用公開リポジトリ：[yutoo77/listen-capture-spike](https://github.com/yutoo77/listen-capture-spike)

## 最初に試す3操作

iPhoneのSafariで公開URLを直接開き、画面を開いたまま試します。

1. **「▶ 再生」**を押し、デモ音声を数秒聴く。
2. **「メモを録音する」**を押し、初回はマイクを許可して、5秒ほど話す。
3. **「録音を終了する」**を押し、保存されたメモと再生復帰を確認する。自動再開されなければ「▶ 再生」を押す。

続けて、メモの録音再生と「元の位置」への復帰を試してください。詳しい実機記録は [TEST_PLAN.md](./TEST_PLAN.md)、実施済み検証は [VALIDATION.md](./VALIDATION.md) に分けています。

## できることと範囲

- 同梱デモ音声、または端末で選んだ音声ファイルを再生する。
- マイク取得より先に再生位置を確定し、一時停止して最長60秒のメモを録音する。
- 録音と参照位置をこのブラウザのIndexedDBへ保存し、再生・削除・ダウンロードする。
- 音声メモの代わりに、再生位置だけの「印」を保存する。
- 技術検証ログを表示・JSONで書き出す。ログは音声そのものを含みません。
- 対応環境でMedia Sessionの再生操作を試す。「次の曲 → 印」は任意の実験です。

**PDF・TTS・STT・クラウド保存・アカウント・認証認可はありません。** ロック中の録音開始、イヤホンだけでの録音開始、バックグラウンド録音の継続は保証しません。ホーム画面向けManifestはありますが、Service Workerを含まずオフラインアプリではありません。

## 保存・復旧で知っておくこと

- 選択した音声と録音をアプリからサーバーへアップロードする処理はありません。サイト本体とデモ音声はHTTPSで取得します。
- ローカル元音声は50MiB以下が対象です。内容のSHA-256を参照の識別に使います。**元音声の実データは永続保存しません。** 再読込後、対応するメモへ戻るには同じファイルを選び直してください。
- 録音中は元音声・別メモの再生、シーク、音源切替を止め、録音へ音が混入する操作を防ぎます。元音声とメモ音声を同時再生しません。
- 録音後のDB保存に失敗した場合、未保存録音の復旧欄から保存を再試行するか、音声ファイルをダウンロードしてください。**復旧欄のデータが再読込・タブ終了後も残る保証はありません。** 未保存のまま画面を閉じないでください。
- 録音中に画面が隠れた場合は停止を試みます。OSによるページ終了・中断前に必ず保存できるとは限りません。重要な音声の保存には使わないでください。
- IndexedDBはこのブラウザ内の保存です。Safariとホーム画面版の共有・保持を前提にせず、必要な録音はダウンロードしてください。ブラウザのデータ削除や容量不足でも失われます。

## 公開サイトとプライバシー

公開GitHubリポジトリとPagesには、静的なコードとデモアセットのみを配置します。講義資料、利用者の録音、個人情報、APIキーはコミットしません。共有端末を避け、**本名・健康情報・研究の秘密などを含む録音で試さないでください。**

GitHub Pagesのプロジェクトサイトは、同じ `https://<user>.github.io` 配下の別プロジェクトと同一originです。パスが違ってもブラウザStorageのセキュリティ境界にはなりません。同一originの別サイトのスクリプトから、IndexedDBなどへアクセスされ得ます。この公開先は音声UXの検証用です。機微情報を扱う本体では、専用origin、認証認可、非公開Storageを改めて設計します。

ログにも日時・再生位置・ファイル情報等が含まれ得ます。共有前に内容を確認してください。

## PCで動かす

このフォルダーで以下を実行し、`http://localhost:8000/` を開きます。

```sh
python -m http.server 8000
```

`localhost`はマイクAPIを利用できる安全なコンテキストの例外ですが、PCのlocalhostをiPhoneからそのまま開けるわけではありません。iPhoneではトップレベルのHTTPS URLを使用します。`file://`の直接起動やiframeプレビューは試験の基準にしません。

## 自動チェック

Node.jsとnpmのある環境で、次を順に実行します。

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

テストはローカルサーバーを起動し、Chromiumの擬似マイクで回帰試験を行います。物理マイク、iPhone、ロック画面、Bluetoothの試験ではありません。CIでも静的チェックと回帰試験を行い、品質チェック後にPagesへ配置します。

## 実装を読む順番

1. `index.html`：再生・録音・復旧・メモの操作。
2. `app.js`：再生位置の確定、録音セッションの開始・停止・マイク解放、保存と再開。
3. `app.js`：IndexedDB、元音声の識別、Media Session、イベントログ。
4. `TEST_PLAN.md`：Safari・ホーム画面・Bluetooth・ロック・割込みの実機条件。

この段階はフレームワークやBackendの選定ではなく、ブラウザの音声操作の検証です。Desktopの擬似マイク試験が成功しても、iPhone実機の成功には数えません。

## 参考

- [getUserMediaと安全なコンテキスト](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MediaRecorderの音声形式の対応確認](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)
- [Media Sessionの操作ハンドラー](https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setActionHandler)
- [GitHub PagesのHTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
