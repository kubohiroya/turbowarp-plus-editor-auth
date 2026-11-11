# TurboWarp Plus Editor Auth

[English](README.md)

TurboWarp Plus Editor が Git プロキシに接続するための TypeScript 契約です。ホストが `GitAuthProvider` を実装し、方式、信頼済みのプロキシのオリジン、認証と切断の操作を提供します。`getState()` は画面表示用の情報を返し、`getSession()` は短命のプロキシ専用 Bearer と Unix ミリ秒単位の有効期限を返します。セッションがなければ `null` を返します。

Desktop のメインプロセスが GitHub の device flow とループバックプロキシを担当します。Cloudflare では BFF が GitHub 認証を、Git 専用プロキシが中継を担当します。各ホストが GitHub の資格情報を管理し、プロキシセッションを接続先・リポジトリ・操作に限定します。Renderer は資格情報をメモリ内に保持し、選択中のプロキシにだけ送ります。切断時は発行元でセッションを失効させます。

`createCloudflareGitAuth` は、設定済みの2つの HTTPS オリジンと、対象 GitHub リポジトリおよび要求する読取・書込権限に接続を限定します。ホストはユーザーの明示操作で `connect()` を呼び、検証済みの GitHub 認証 URL を開く処理を `openAuthorization` として渡します。認証の完了は `getState()` で確認できます。ログインチケットは BFF にのみ送信し、Git プロキシ専用の短命 Bearer は `getSession()` で取得します。失効の通信に失敗した場合は `disconnect()` を再試行できます。

`createGitConnectionSettings` は Git パネルに表示状態と接続操作を渡します。Desktop の `EditorPreload.localGit` と、設定済みの Cloudflare オリジンを受け取ります。方式の切り替えでは現在のセッションの失効を待ちます。既定では読取権限を要求し、push は選択したリポジトリと方式に対する明示的な許可が必要です。push とは別の任意の review の許可（`connect(remote, write, review)`）を求めると、push の権限なしでプロキシ経由で pull request のレビューを送れます。表示状態は `review` を持ち、`getSession(remote, write, review)` は求めた許可がなければ `null` を返します。Cloudflare は `/start` の本文に `review` を入れ、Desktop は `authorizeRepository` に渡します。

Node.js 26 で `npm ci` と `npm run build` を実行すると、Vite のライブラリエントリと TypeScript の型宣言が生成されます。 [接続契約と作業範囲](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)

## 公開

npm への公開は `.github/workflows/release.yml` が行う。`package.json` の版と同じ `v<版>` のタグを
`main` のコミットに push すると、テストを通したうえで npm に入れるアーカイブを作り、GitHub Release に
添付してから npm に公開し、`latest` と `next` をその版に向ける。認証はトークンではなく npm の
Trusted Publisher（OIDC）で、provenance を付けて公開する。npm 側の設定にはこのワークフローの
ファイル名をそのまま登録するため、改名するときは npm の設定も合わせる。
