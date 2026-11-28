# TurboWarp Plus Editor Auth

## ペア作業の複数アカウント

`createGitAccountConnections` は、Desktop の `DesktopGitAccounts` または設定済みのCloudflare認証から、アカウントごとに独立した接続を作ります。追加・切断はその接続だけに適用します。`bind(id)` で操作に使う接続を固定し、後の画面上の選択が実行中の操作を別アカウントへ向けないようにします。ペア用Cloudflare認証ではGitHubのアカウント選択を要求し、既存の単独接続の動作は維持します。資格情報をタイムラインへ渡しません。[Editor #883](https://github.com/kubohiroya/turbowarp-plus-editor/issues/883)

[English](README.md)

TurboWarp Plus Editor が Git プロキシに接続するための TypeScript 契約です。ホストが `GitAuthProvider` を実装し、方式、信頼済みのプロキシのオリジン、認証と切断の操作を提供します。`getState()` は画面表示用の情報を返し、`getSession()` は短命のプロキシ専用 Bearer と Unix ミリ秒単位の有効期限を返します。セッションがなければ `null` を返します。

Desktop のメインプロセスが GitHub の device flow とループバックプロキシを担当します。Cloudflare では BFF が GitHub 認証を、Git 専用プロキシが中継を担当します。各ホストが GitHub の資格情報を管理し、プロキシセッションを接続先・リポジトリ・操作に限定します。Renderer は資格情報をメモリ内に保持し、選択中のプロキシにだけ送ります。切断時は発行元でセッションを失効させます。

`createCloudflareGitAuth` は、設定済みの2つの HTTPS オリジンと、対象 GitHub リポジトリおよび要求する読取・書込権限に接続を限定します。ホストはユーザーの明示操作で `connect()` を呼び、検証済みの GitHub 認証 URL を開く処理を `openAuthorization` として渡します。認証の完了は `getState()` で確認できます。ログインチケットは BFF にのみ送信し、Git プロキシ専用の短命 Bearer は `getSession()` で取得します。失効の通信に失敗した場合は `disconnect()` を再試行できます。

`createGitConnectionSettings` は Git パネルに表示状態と接続操作を渡します。Desktop の `EditorPreload.localGit` と、設定済みの Cloudflare オリジンを受け取ります。方式の切り替えでは現在のセッションの失効を待ちます。既定では読取権限を要求し、push は選択したリポジトリと方式に対する明示的な許可が必要です。push とは別の任意の review の許可（`connect(remote, write, review)`）を求めると、push の権限なしでプロキシ経由で pull request のレビューを送れます。表示状態は `review` を持ち、`getSession(remote, write, review)` は求めた許可がなければ `null` を返します。Cloudflare は `/start` の本文に `review` を入れ、Desktop は `authorizeRepository` に渡します。プロキシがリポジトリの名前を変えたあと（`POST /v1/github/<owner>/<repo>/name`）は、`renameRemote(from, to)` で接続を新しいリモートへ移します。プロキシがセッションを新しい名前に結び付け直しているので、ログインはやり直しません。接続が別のリポジトリのものなら `false` を返します。

Node.js 26 で `npm ci` と `npm run build` を実行すると、Vite のライブラリエントリと TypeScript の型宣言が生成されます。 [接続契約と作業範囲](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)

## 新しいリポジトリの作成契約

`createRepositoryCreationClient` は、ホストのアカウント認証から受け取った作成専用の `CreationGrant` を検証し、作成先を取得して `CreationSession` を返します。OAuth トークンはホストが保管します。`scope` は `repository-creation`、Bearer は通常の Git セッションと区別する `create.` 付きの値です。クライアントは、設定したオリジンの `/v1/github-create/` にだけ Bearer を送ります。ホストでもスコープ、失効、アカウント、作成先と公開範囲の許可を毎回確認します。

作成 API はアカウントと公開範囲を照合して空のリポジトリを作ります。作成結果の確認後に、初期コミットの push 用として、そのリポジトリ ID に限定した通常の Git セッションを取得します。

`createRepositoryCreationHost` は、作成前に操作 ID、作成先、公開範囲、初期ファイルのダイジェスト、確認済みの Topics を記録します。応答が途切れた場合は `unknown` を返します。作成日時と空であることを確認できたリポジトリも候補として扱い、利用者がリポジトリ ID を確認し、ホストで同じ ID を再確認した場合に引き継ぎます。Topics の設定では記録した操作 ID とリポジトリ ID を照合します。Topics の失敗後も作成済みのリポジトリ ID は保持します。永続ストレージ、ホスト認証、GitHub 中継ルートはホスト側の実装段階で接続します。 [作成機能の追跡](https://github.com/kubohiroya/turbowarp-plus-editor/issues/525)

GitHub の公開仕様では、専用の **Repository creation（書き込み）** または **Administration（書き込み）** が作成の権限です。GitHub App は専用権限で自身が作成したリポジトリへのアクセスを得ます。Topics を設定する API は Administration（書き込み）を要求します。作成・初期 push・Topics の権限は別々に確認し、認証方式ごとの対応は承認された検証環境で確認します。 [GitHub App の権限](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) · [個人リポジトリの作成](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user) · [組織リポジトリの作成](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository) · [Topics の更新](https://docs.github.com/en/rest/repos/repos#replace-all-repository-topics)

## 不変のユーザーID

`GitAccount.id` はGitHubの数値ユーザーIDです。従来の単独接続との互換性のため型では省略可能ですが、`createGitAccountConnections` が発行するペア用の接続は正の安全な整数IDを必須にします。ログイン名の一致だけでは接続の統合・昇格・再利用を行いません。同じIDの名前変更は同じ人として扱い、取得中のセッションが別IDへ変わった場合は拒否します。サインアウトの表示記録にも確認済みIDを保持します。

CloudflareのBFFはOAuth完了時と更新時に `GET /user` のIDを確認し、セッションの `account.id` として返す必要があります。旧BFFがIDを返さない場合はペアの認証を再確認が必要な状態にし、送信者をログイン名から推測しません。

## ペア接続のサインアウト

`createGitAccountConnections` はアカウントごとの停止結果を `signOut` として公開します。停止要求は直列の認証コマンドを待たずに適用し、取得中のセッションと待機済みコマンドも再利用できなくします。`subscribe` で表示の変更を通知し、`disconnectAll` と `dispose` は失敗した接続があっても全接続の停止を試みます。`dispose` 後の再接続は拒否します。

失効失敗時は接続を停止したまま再試行できます。ブラウザーでは接続識別子・公開ログイン名・時刻・確認状態だけを `tw-plus-pair-signouts-v1` に最大100件保存します。`signOutStorage` で保存先を差し替えられます。資格情報を永続化しないため、再起動後の未確認記録から接続を復元したり失効APIを自動実行したりしません。`recorded` は端末への結果保存の成否、`retryable` は現在の画面で再試行可能かを示します。

従来BFFの `204` または `401` はプロキシセッションの利用停止だけを確認し、GitHub側の失効は `unconfirmed` とします。将来の対応BFFが `202` を返す場合はプロキシ停止済み・GitHub失効待ちとして保持し、`204` と `X-GitHub-Revocation: token` または `authorization` を返した場合だけ該当範囲の確認済み状態にします。BFF側はこのヘッダーをブラウザーへ公開し、確認した範囲だけを返す必要があります。現行Desktopと従来BFFのGitHub側失効は本人が公式の認可画面で確認する方式です。ブラウザーのGitHubセッション終了を自動実行・確認したものとは扱いません。

## 公開

npm への公開は `.github/workflows/release.yml` が行う。`package.json` の版と同じ `v<版>` のタグを
`main` のコミットに push すると、テストを通したうえで npm に入れるアーカイブを作り、GitHub Release に
添付してから npm に公開し、`latest` と `next` をその版に向ける。認証はトークンではなく npm の
Trusted Publisher（OIDC）で、provenance を付けて公開する。npm 側の設定にはこのワークフローの
ファイル名をそのまま登録するため、改名するときは npm の設定も合わせる。

### 共通アカウント画面の接続

`createGitAccountConnections` に既存の `createGitConnectionSettings` を `primary` として渡せます。GitHub Appの独立スロットと、既存DesktopのPAT・Git credential helper・保存済み接続の復元を同じ一覧とサインアウト経路で扱います。primaryの同時接続開始は拒否し、終了前に新しい操作が旧接続を置き換えないようにします。新しいUIとGit操作は、このプールを共有します。
