# TurboWarp Plus Editor Auth

[English](README.md)

TurboWarp Plus Editor が Git プロキシに接続するための TypeScript 契約です。ホストが `GitAuthProvider` を実装し、方式、信頼済みのプロキシのオリジン、認証と切断の操作を提供します。`getState()` は画面表示用の情報を返し、`getSession()` は短命のプロキシ専用 Bearer と Unix ミリ秒単位の有効期限を返します。セッションがなければ `null` を返します。

Desktop のメインプロセスが GitHub の device flow とループバックプロキシを担当します。Cloudflare では BFF が GitHub 認証を、Git 専用プロキシが中継を担当します。各ホストが GitHub の資格情報を管理し、プロキシセッションを接続先・リポジトリ・操作に限定します。Renderer は資格情報をメモリ内に保持し、選択中のプロキシにだけ送ります。切断時は発行元でセッションを失効させます。

Node.js 26 で `npm ci` と `npm run build` を実行すると、Vite のライブラリエントリと TypeScript の型宣言が生成されます。 [接続契約と作業範囲](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)
