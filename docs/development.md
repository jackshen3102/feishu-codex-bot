# Development

Use Node.js 22 and pnpm. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` from the repository root.

Tests use fake Feishu adapters and temporary SQLite/workspace paths. They do not need production credentials. A live preflight requires a configured Feishu application and Codex login. Do not run a second WebSocket client against an application already in use by a production instance.
