# Configuration

The gateway reads its process environment. Keep its environment file outside the checkout with mode `0600`. Docker Compose passes it to the gateway; Codex receives an explicit allowlist instead of inheriting gateway secrets.

| Variable | Purpose |
| --- | --- |
| `FEISHU_APP_ID` | New Oncall application's ID |
| `FEISHU_APP_SECRET` | New application's secret |
| `ONCALL_CONFIG_PATH` | Absolute business-workspace JSON path; Compose sets `/config/oncall.json` |
| `FEISHU_CHAT_ID` | Legacy group ID; not required in Oncall mode |
| `FEISHU_PRIVATE_CHAT_ID` | Legacy private-chat ID; not required in Oncall mode |
| `AGENT_BACKEND` | Initial backend for a new database: `codex` (default) or `traex`; saved administrator selection takes precedence |
| `TRAEX_BINARY` | Optional absolute executable path; defaults to `traex` on the service PATH |
| `TRAEX_HOME` | Dedicated TRAE login/config home; defaults to sibling `traex` beside `CODEX_HOME` |
| `CODEX_HOME` | Dedicated Codex home; Compose sets `/data/codex` |
| `STATE_DB_PATH` | SQLite file; Compose sets `/data/state/bot.db` |
| `WORKSPACE_ROOT` | Topic directories; Compose sets `/data/topics` |
| `MAX_CONCURRENT_TURNS` | Cross-topic execution limit; defaults to `5` |
| `TURN_TIMEOUT_MS` | `0` disables total turn timeout (default); positive values must be at least `60000` |
| `WORKSPACE_RETENTION_DAYS` | Legacy idle topic-directory retention; at least `1`; image defaults to `30` |
| `JOB_RETENTION_DAYS` | Legacy completed-job retention; defaults to `90` |

`AGENT_BACKEND` may be omitted or set to `codex` or `traex`. Each engine must have its own login home. Paths must be normalized absolute paths. `CODEX_HOME` and `WORKSPACE_ROOT` must not overlap; the database must be outside the workspace root. Retention settings apply to legacy cleanup only. All Oncall topics and jobs are excluded from that cleanup to retain cases, evidence and unfinished work; this version has no automatic Oncall archival/deletion. Shared cases remain in SQLite.

## Oncall workspace file

Create `oncall.json` in the dedicated configuration directory. This supports private testing before a group exists:

```json
{
  "workspaces": [
    {
      "id": "infra-workspace",
      "knowledgePaths": ["/knowledge/repositories.md"],
      "repositories": []
    }
  ],
  "groupBindings": [],
  "privateBinding": {
    "chatId": "oc_REPLACE_PRIVATE_CHAT",
    "ownerOpenId": "ou_REPLACE_OWNER",
    "workspaceId": "infra-workspace"
  },
  "maxAttachmentBytes": 20971520,
  "agentEnvironment": {}
}
```

Use real IDs before connecting. The private binding accepts only that owner's messages. Add a group with `{"chatId":"oc_REPLACE_GROUP","workspaceId":"infra-workspace"}` in `groupBindings`. IDs must be unique and bindings must reference declared workspaces. Restart the bot to reload configuration.

`knowledgePaths` lists files/directories visible **inside the container**. Copy relevant association/reference documents into the knowledge mount. The bot does not run the source workspace's setup or OMH workflows. An empty repository list is valid.

A repository entry, when needed:

```json
{
  "name": "example-service",
  "url": "https://git.example.com/team/example-service.git",
  "description": "Ownership and investigation hints",
  "defaultRef": "main"
}
```

Optional `sourcePath` points to an existing container-local checkout/cache; omit it when there is none. Preflight checks configured paths. Metadata itself neither clones repositories nor creates worktrees.

`agentEnvironment` accepts non-secret tool selectors supported by the actual CLI. Credential-like names, gateway names and process overrides such as `HOME`, `PATH` or `NODE_OPTIONS` are rejected. Mount a tool's dedicated login/config directory under `/tool-home` and configure that tool's documented selector; do not put credentials in this JSON or copy the host home. Tools that only use their home directory can keep dedicated login state under the persistent `/data` home (the location depends on the selected tool). The agent environment also includes locale, explicit `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` settings and `CODEX_HOME`.

## Execution modes

Oncall uses unrestricted Codex execution **inside its dedicated container** for both private and group topics. User-request requirements are expressed in Oncall instructions; Docker does not restrict remote account permissions. Provision the intended account and tools. Do not use Oncall mode as a host execution shortcut.

Legacy mode preserves group sandboxing through `scripts/codex-isolated.sh` and unrestricted private execution. Group mode needs user namespaces; Docker deployment does not add privileged mode to accommodate it.

## Business-tool checks

Preflight accepts `--tools /config/tool-checks.json`. Each entry provides separate installation, login and target-access commands. Commands execute directly with argument arrays and the agent environment, without a shell. Output is discarded; only stage and success/failure are printed.

```json
[
  {
    "name": "business-cli",
    "available": { "command": "/opt/oncall-tools/bin/business-cli", "args": ["--version"] },
    "login": { "command": "/opt/oncall-tools/bin/business-cli", "args": ["auth", "status"] },
    "resource": { "command": "/opt/oncall-tools/bin/business-cli", "args": ["get", "REPLACE_READABLE_RESOURCE"] }
  }
]
```

This illustrates the schema, not a provided CLI. Replace commands with actual read-only interfaces. Each must exit nonzero when its check fails. Do not put tokens in arguments. Each probe has a 30-second timeout. `--offline` only runs availability checks; normal preflight runs all three. A missing checks file means business access is **not verified**.

## Optional management Web

Web is disabled by default and runs in the existing bot process after the gateway starts. Web configuration or startup failure is logged as `management_web_unavailable` and does not stop the gateway.

| Variable | Default / purpose |
| --- | --- |
| `WEB_ENABLED` | `false`; only literal `true` enables Web |
| `WEB_HOST` | `127.0.0.1`; Docker overlay uses `0.0.0.0` inside the container |
| `WEB_PORT` | `6193`; a conflict fails Web startup, without choosing another port |

With no authentication integration configured, the management page opens directly through the existing Runweave local-preview channel. It has no separate administrator password, HTTP Basic requirement, application session cookie or Web password file. It reads all configured workspaces, including the owner's private-chat records. Authentication-enabled deployments supply a verifier and login resources through the integration interface described in [extensions](extensions.md).

Data views accept GET/HEAD. The sole write endpoint is `PUT /api/oncall/agent-settings`, available only through the running gateway through the local management entry with an exact matching Origin and a JSON body. Responses are not cached. Host and Origin checks admit localhost, loopback addresses and `.localhost` preview hosts on the configured port, plus the exact configured SSO public origin when SSO is enabled. Runweave's iOS local preview uses a per-page `.localhost` host; the request Origin must still match that exact host and port. There is no CORS access, directory browsing, file-download API or business-tool probe. Results and evidence are untrusted text; only existing HTTP(S) evidence URLs become links.

Web opens a separate `readonly` SQLite connection with `query_only=ON`, without using the mutating Store constructor. It does not migrate, recover or reschedule jobs. The normal gateway retains sole ownership of execution and delivery.

Execution, topic pause, final-reply delivery and per-conclusion verification are separate fields. Delivery aggregates every `final_reply` chunk, so a successful execution can still have a partially delivered result. Historical views read the exact job's case history and do not borrow the topic's latest case. Missing data remains missing.

The visible health state is the existing process snapshot; older than 90 seconds is stale. It does not establish a live Feishu connection, CLI login or business-resource access. Workspace configuration shown by Web is the snapshot loaded at startup; restart to reload existing configuration changes. Workspace bindings and business configuration remain unchanged by Web.

## Administrator model selection

In **工作区 → 模型设置**, choose `Codex` or `traex`, enter the model ID accepted by that engine, or leave it blank to use its configured default. Save to apply globally across workspaces from the next execution. Queued work uses the selection when it starts. Active work, including cancellation and output-format correction, keeps its original engine/model. No Feishu command or card exposes model switching.

SQLite stores the selection persistently; restarting does not overwrite it with `AGENT_BACKEND`. Schema v13 retains separate sessions for each topic and backend, importing existing Codex sessions from v12. Switching back resumes that engine's previous session; the other engine's intervening internal tool history is not transferred. Oncall continues supplying its normal topic context and workspace files. Model changes within one engine retain its session. Running jobs are never automatically retried on restart.

Install a pinned TRAE CLI release in the service environment and log in using its **dedicated** home before selecting it. The adapter uses `--no-daemon`, `exec --json`, output schemas and `exec resume`; it translates the Codex SDK's flag differences and retains process-group cancellation and legacy group isolation. It passes the same explicit environment allowlist, with `TRAE_HOME`, and never inherits gateway credentials. Model IDs are syntax-checked; their availability and account access are determined by the selected engine.

For local operator login, with the normal service environment already loaded:

```sh
pnpm exec tsx scripts/traex-cli.ts login
pnpm exec tsx scripts/traex-cli.ts login status
pnpm preflight -- --traex-only
```

The last command verifies TRAE login plus a real shell-tool/structured-response turn in a temporary workspace, without connecting a Feishu WebSocket. Preflight otherwise checks `AGENT_BACKEND` (default Codex); use the explicit flag when checking a Web-selected TRAE backend. Do not pass login tokens in CLI arguments.
