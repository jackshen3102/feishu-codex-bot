# Independent integrations

The core uses public dependencies and does not discover or import an organization-specific repository. Integrations install a fixed release package and derive runtime images from a fixed core image. The two repositories need not be adjacent.

## Release package

Run `pnpm package:core` to build declarations, runtime code and the versioned tarball in `artifacts/`. Record the tarball SHA-256 alongside its version. It contains the runtime, browser assets, workspace template and process wrappers, without deployment configuration or account state. Keep the matching tarball and runtime image together as a release. Package consumers must install dependencies normally, including the supported Codex platform binary and SQLite native module.

Public exports:

- `feishu-codex-bot`: `startApplication({ configureWeb? })`; importing it does not start a gateway.
- `feishu-codex-bot/web`: Web server functions, configuration loader, authentication types and `WebError`.
- `feishu-codex-bot/oncall`: workspace configuration loader and types.
- `feishu-codex-bot/schema`: SQL schema resource for isolated fixtures.
- `feishu-codex-bot/web-public`: browser index resource; its directory contains the version's browser assets.

Do not import unpublished source paths. Internal API changes require a new core release and consumer compatibility checks.

## Authentication

`startWebServer` accepts an explicit `WebAuthentication` object. It supplies a request verifier returning the verified email/name/avatar, canonical origin, allowed emails, a browser session module and optional JavaScript assets/browser connection sources. The core applies email authorization and same-origin model-setting restrictions after verification. Authentication failures use `WebError(401, ...)`; verified accounts outside the allowlist receive 403; verifier infrastructure failures should use 503.

The session module implements the exports used by `app.js`: `initializeSession`, `currentSession`, `authorizedFetch`, `signIn`, `signOut` and `agentSettingsAvailable`. It must use `/api/oncall/me` for verified identity, and clear private UI data on session failure or logout. `clientConfig` is public bootstrap data and must not contain credentials or private configuration.

Set `config.authenticationRequired` or `WEB_AUTH_REQUIRED=true` to reject missing authentication. The legacy `WEB_SSO_ENABLED=true` configuration is rejected by the default entrypoint; choose the integration's explicit startup entrypoint. Authentication must never silently fall back to the local entry.

`startStandaloneWeb` requires authentication and discards any supplied `agentControl`. It only reads existing data; it does not construct a gateway, migrate the database or open a Feishu WebSocket.

## Runtime compatibility

The default local entry uses the existing loopback preview boundary. External entries require an authentication integration. Business tools and login state are supplied by the deployment; gateway credentials are never passed to an agent. Keep the same persistent database and workspaces when changing the entrypoint. Wait for execution and delivery to be idle before replacing the sole live bot.
