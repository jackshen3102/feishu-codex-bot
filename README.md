# Feishu Codex Bot

A standalone Feishu Oncall bot. Each chat topic has its own Codex session and working directory; a business workspace supplies optional knowledge, repository references and shared cases. The bot chooses its investigation path from the evidence. A question does not automatically clone a repository or create a branch.

## Oncall behavior

- Supports the configured owner's private chat and bound groups. Both use topics and @mentions to start analysis; ordinary topic replies accumulate as context.
- Accepts text, images, log attachments and links. Fetches related topic history when available and reports missing context.
- Shares a topic across participants and runs it in order. Defaults to five concurrent topics, with no total turn timeout.
- Replaces the progress card with the final reply in place. Oversized replies continue in ordered chunks; unavailable or uneditable cards fall back to a text reply.
- Stops and pauses the entire topic on an authorized stop request, preserving queued requests. Explicit continue resumes it. Interrupted topics remain paused after restart.
- Investigates autonomously. Online retries, configuration changes, code edits and MR creation require an explicit user request for that action.
- Saves cases within the associated business workspace, including private-chat and group cases. Facts and unverified hypotheses remain distinct.
- Runs the new Oncall application in its own Docker container and persistent volume, independently of Runweave and OMH. Both chat types use the container execution boundary and the same product authorization rules.

Without `ONCALL_CONFIG_PATH`, the legacy single-group/single-private-chat setup remains available. Oncall bindings can contain no groups while the owner tests privately.

## Requirements

- Docker Engine with Compose v2 for the new deployment; Node.js 22 and pnpm for local development
- A **new** Feishu application with WebSocket event delivery and the message, history, resource and card permissions used by the bot
- The owner's private-chat ID and open ID; group IDs can be added later
- A dedicated Codex login and the business tools/credentials needed for the selected workspace

See [configuration](docs/configuration.md), [Docker deployment and verification](docs/deployment.md), and [architecture](docs/architecture.md). An image build or offline preflight does not establish that Codex, configured tools or real Feishu topic interactions work.

## Develop

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Use temporary databases and workspaces for local checks. Do not connect another WebSocket client to a running application. Keep application secrets, raw cases and runtime data outside the checkout.

## Read-only management Web

An optional owner-only Web entry provides an operational overview, per-topic execution history, workspace cases and configuration views. Execution state, final-reply delivery and conclusion verification are displayed independently. All analysis and execution actions continue through Feishu.

The entry is disabled by default. See [configuration](docs/configuration.md#optional-management-web), [Docker enablement](docs/deployment.md#enable-the-management-page), and [isolated development verification](docs/development.md#read-only-web-development). With the Web overlay enabled, the local URL is **http://localhost:6193**. It opens directly through the existing local-preview channel without a separate login and does not add another Feishu WebSocket connection.

Administrators can select Codex or traex and its model from **工作区 → 模型设置**. Selection persists in SQLite and applies to subsequent executions. See [TRAE setup](docs/configuration.md#administrator-model-selection); Feishu users have no switching command.

## Extension boundary

The default package and runtime use public dependencies only. Authentication providers, platform hosting and organization-specific tools belong in separate repositories and consume a fixed core release. See [the integration contract](docs/extensions.md).
