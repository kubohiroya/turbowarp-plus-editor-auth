# TurboWarp Plus Editor Auth

[English](README.md)

TurboWarp Plus Editor が Git プロキシに接続するための TypeScript 契約です。ホストが `GitAuthProvider` を実装し、方式、信頼済みのプロキシのオリジン、認証と切断の操作を提供します。`getState()` は画面表示用の情報を返し、`getSession()` は短命のプロキシ専用 Bearer と Unix ミリ秒単位の有効期限を返します。セッションがなければ `null` を返します。

Desktop のメインプロセスが GitHub の device flow とループバックプロキシを担当します。Cloudflare では BFF が GitHub 認証を、Git 専用プロキシが中継を担当します。各ホストが GitHub の資格情報を管理し、プロキシセッションを接続先・リポジトリ・操作に限定します。Renderer は資格情報をメモリ内に保持し、選択中のプロキシにだけ送ります。切断時は発行元でセッションを失効させます。

`createCloudflareGitAuth` は、設定済みの2つの HTTPS オリジンと、対象 GitHub リポジトリおよび要求する読取・書込権限に接続を限定します。ホストはユーザーの明示操作で `connect()` を呼び、検証済みの GitHub 認証 URL を開く処理を `openAuthorization` として渡します。認証の完了は `getState()` で確認できます。ログインチケットは BFF にのみ送信し、Git プロキシ専用の短命 Bearer は `getSession()` で取得します。失効の通信に失敗した場合は `disconnect()` を再試行できます。

`createGitConnectionSettings` は Git パネルに表示状態と接続操作を渡します。Desktop の `EditorPreload.localGit` と、設定済みの Cloudflare オリジンを受け取ります。方式の切り替えでは現在のセッションの失効を待ちます。既定では読取権限を要求し、push は選択したリポジトリと方式に対する明示的な許可が必要です。

Node.js 26 で `npm ci` と `npm run build` を実行すると、Vite のライブラリエントリと TypeScript の型宣言が生成されます。 [接続契約と作業範囲](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)
