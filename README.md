# TurboWarp Plus Editor Auth

[日本語](README.ja.md)

TypeScript contracts for connecting TurboWarp Plus Editor to a Git proxy. A host implements `GitAuthProvider` and supplies the connection mode, trusted proxy origin and session lifecycle. `getState()` returns display data and `getSession()` supplies an ephemeral proxy Bearer credential and an expiration time in Unix milliseconds. A missing session is represented by `null`.

Desktop handles GitHub device authorization and the loopback proxy in its main process. Cloudflare uses a BFF for GitHub authorization and a Git-only proxy. Each host owns GitHub credentials and scopes its proxy sessions to the intended service, repository and operations. Keep the renderer's proxy credential in memory and pass it only to the selected proxy. Disconnect revokes the session on its issuer.

`createCloudflareGitAuth` binds a provider to two configured HTTPS origins, the selected GitHub repository and its requested read or write access. The host calls `connect()` after an explicit user action and supplies `openAuthorization` to open the validated GitHub URL. After GitHub redirects to the BFF, the host can poll `getState()` while the login is pending. The provider sends the login ticket to the BFF and exposes a separate short-lived proxy Bearer via `getSession()`. The host can retry `disconnect()` if revocation fails.

`createGitConnectionSettings` supplies the Git panel with display state and explicit connection actions. It accepts the Desktop `EditorPreload.localGit` bridge and the configured Cloudflare origins. Switching providers waits for the previous session to be revoked. The settings request read-only repository authorization.

Run `npm ci` and `npm run build` with Node.js 26 to produce the Vite library entry and TypeScript declarations. [Contract and integration scope](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315).
