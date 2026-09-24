# Repository guidance

- Keep the gateway independent of user intent. Route messages and jobs without classifying requests.
- SQLite is the source of truth for topic routing, job state, recovery, and reply delivery.
- Never automatically retry a running job after restart because its external effects may be unknown.
- Pass only an explicit environment allowlist to Codex. Never pass the Feishu app secret or tenant token.
- Do not log message bodies, Codex output, authorization headers, or credentials.
- Use temporary SQLite databases and workspaces for local checks. Do not connect a second WebSocket client to a live application during development.
