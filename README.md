# TurboWarp Plus Editor Auth

[日本語](README.ja.md)

TypeScript contracts for connecting TurboWarp Plus Editor to a Git proxy. A host implements `GitAuthProvider` and supplies the connection mode, trusted proxy origin and session lifecycle. `getState()` returns display data and `getSession()` supplies an ephemeral proxy Bearer credential and an expiration time in Unix milliseconds. A missing session is represented by `null`.

Desktop handles GitHub device authorization and the loopback proxy in its main process. Cloudflare uses a BFF for GitHub authorization and a Git-only proxy. Each host owns GitHub credentials and scopes its proxy sessions to the intended service, repository and operations. Keep the renderer's proxy credential in memory and pass it only to the selected proxy. Disconnect revokes the session on its issuer.

Run `npm ci` and `npm run build` with Node.js 26 to produce the Vite library entry and TypeScript declarations. [Contract and integration scope](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315).
