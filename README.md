# Feishu Codex Bot

A standalone Feishu bot that runs Codex for messages in one configured group and one configured private chat. Each conversation topic keeps its own Codex session and workspace. SQLite stores routing, jobs, status, and replies so queued work survives a service restart.

## Features

- Group messages require an @mention. Messages in the configured private chat do not.
- Replies in a topic resume its Codex session. Separate top-level private messages start separate sessions.
- Accepts PNG, JPEG, GIF, and WebP input images up to 5 MiB each.
- Runs jobs in topic order, with configurable concurrency across topics.
- Shows one status card per job, supports cancellation, and resumes pending reply delivery after restart.
- Runs group jobs with Codex workspace-write sandbox in an isolated process namespace. The configured private chat runs with unrestricted Codex permissions. Only grant private chat access to someone trusted to operate the service account.
- Stores no application secret or message text in structured logs.

## Requirements

- Linux with systemd and user namespaces enabled
- Node.js 22 and pnpm
- A Feishu application with WebSocket event delivery and the message, resource, card, and reaction permissions used by this bot
- A Codex login for the dedicated service user

## Develop

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The repository contains no deployment credentials. Keep application secrets in a root-readable environment file outside the checkout. See [configuration](docs/configuration.md), [deployment](docs/deployment.md), and [architecture](docs/architecture.md).
