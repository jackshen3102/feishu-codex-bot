# Configuration

The service reads configuration from its process environment. Keep the environment file outside the repository with permission mode `0600`.

| Variable | Purpose |
| --- | --- |
| `FEISHU_APP_ID` | Feishu application ID |
| `FEISHU_APP_SECRET` | Feishu application secret |
| `FEISHU_CHAT_ID` | Allowed group chat ID |
| `FEISHU_PRIVATE_CHAT_ID` | Allowed private chat ID; must differ from the group ID |
| `CODEX_HOME` | Dedicated Codex home directory |
| `STATE_DB_PATH` | SQLite database file |
| `WORKSPACE_ROOT` | Root for topic workspaces |
| `MAX_CONCURRENT_TURNS` | Maximum concurrent jobs across topics |
| `TURN_TIMEOUT_MS` | Per-turn timeout; at least 60000 |
| `WORKSPACE_RETENTION_DAYS` | Idle workspace retention; at least 1 |
| `JOB_RETENTION_DAYS` | Completed job retention; defaults to 90 |

`AGENT_BACKEND` may be omitted or set to `codex`. All paths must be normalized absolute paths. `CODEX_HOME` and `WORKSPACE_ROOT` must not overlap, and the database must be outside the workspace root.

The service passes a small environment allowlist to Codex: `PATH`, `HOME`, `TMPDIR`, locale, `CODEX_HOME`, and validated HTTP(S) proxy settings. The application secret stays in the gateway process. Group jobs use the Codex sandbox; private chat jobs use unrestricted Codex permissions under the service user's operating-system privileges.
