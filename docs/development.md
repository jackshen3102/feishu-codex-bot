# Development

Use Node.js 22 and pnpm. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` from the repository root.

Tests use fake Feishu adapters and temporary SQLite/workspace paths. They do not need production credentials. A live preflight requires a configured Feishu application and Codex login. Do not run a second WebSocket client against an application already in use by a production instance.

## Read-only Web development

`pnpm build` packages `src/web/public` in `dist/web/public`; the runtime Docker target copies those assets with the compiled backend. No frontend build tool is required.

`pnpm web:verify` creates its own temporary SQLite database and actual HTTP listener, validates direct local access, read-only queries, workspace ownership, delivery aggregation, keyset pagination, corrupt-data handling, live WAL visibility and shutdown, then removes only its own fixture. Existing gateway integration tests also verify Web-disabled startup, isolated Web failures and HTTP cleanup with fake Feishu adapters.

Use an isolated browser without `httpCredentials`, session cookies or storage state. Open a historical topic URL on a `.localhost` preview host, reload and switch pages directly; no login form or authentication prompt should appear. The old standalone password-login assets and endpoints are removed; platform SSO is optional. The HTTP verification script checks direct access, absence of authentication/cookie response headers, origin boundaries and unchanged business data.

For browser acceptance, start an isolated fixture with an empty directory:

```bash
ONCALL_WEB_FIXTURE_DIR="$(mktemp -d /tmp/oncall-web-acceptance.XXXXXX)"
pnpm web:fixture -- --port 6193 --state-dir "$ONCALL_WEB_FIXTURE_DIR"
```

The command prints only its localhost URL and fixture/config paths. It writes a Playwright standalone config without HTTP credentials to `browser.config.json` (mode 0600). No password file is needed. The fixture contains synthetic records and does not start Gateway, Codex or a Feishu connection. It refuses nonempty directories. SIGTERM/SIGINT closes its listener and SQLite connection; the operator-owned directory remains for inspection.

Use the repository-pinned Playwright CLI in the Runweave tooling checkout with the isolated fixture browser config, not an existing user tab. Run [the required YAML acceptance cases](testing/oncall/readonly-web.testplan.yaml) against the actual HTTP page. The static prototype is not acceptance evidence for the implemented Web. Never point the fixture or write checks at production data.

The completed implementation and isolated acceptance evidence are recorded in [2026-10-25 Web acceptance](testing/results/2026-10-25-oncall-web/README.md). The existing production bot has not been switched to the Web-enabled image.

Model switching is covered by `test/agent-switching.integration.test.ts` and `test/agent-settings-web.integration.test.ts`: persistent selection, v12 migration, per-engine resume, in-flight selection/cancellation, real SDK/supervisor subprocess invocation using a fixture CLI, and administrator write restrictions. `web:fixture` exposes the settings form against its temporary Store, without any Feishu connection or actual model invocation. Live TRAE account/model validation remains the operator's `preflight -- --traex-only` check.
