# Docker deployment

The default image contains Node.js 22, public dependencies and the bundled Codex runtime. Business tools and organization-specific authentication belong in separately built extension images.

Prepare protected files outside the checkout: a gateway environment file, `config/oncall.json`, a knowledge directory and a dedicated tool configuration directory. Set `ONCALL_ENV_FILE`, `ONCALL_CONFIG_DIR`, `ONCALL_KNOWLEDGE_DIR` and `ONCALL_TOOL_HOME` in a Compose environment file. Follow [configuration](configuration.md) for the required application and workspace fields.

```sh
docker compose --env-file /path/to/compose.env config --quiet
docker compose --env-file /path/to/compose.env build bot
docker compose --env-file /path/to/compose.env run --rm --no-deps bot pnpm preflight -- --offline
```

The preflight command does not connect a Feishu WebSocket. Complete the dedicated Codex login and required Feishu application setup before starting the sole live client. Do not copy unrelated host credentials or configuration.

```sh
docker compose --env-file /path/to/compose.env up -d --no-build bot
docker compose --env-file /path/to/compose.env exec bot pnpm status
```

The persistent volume retains the database, session state and topic workspaces. Before replacing the bot, wait for active execution and delivery to finish, stop the service and back up its data/configuration. Running jobs are never replayed automatically after interruption. Use uniquely tagged matching images for rollback, preserving any newer business data.

## Local management page

Combine `compose.yaml` and `compose.web.yaml` to expose the local management page at http://localhost:6193. It reads private as well as group records. Authentication-free access is intended for the existing local preview boundary; use an explicit authentication integration for an external entry.

## Custom images

A separate repository can derive from the `runtime` image to install its own tools and authenticated entrypoint. Fixed-version integration packages use the [public API](extensions.md). Supply proxy settings and CA trust to dependency-installing build stages without embedding account credentials.
