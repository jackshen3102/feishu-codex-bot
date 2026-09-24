# Architecture

The gateway receives Feishu WebSocket events, validates the configured chats, and binds each message to a topic. A SQLite database stores topic bindings, FIFO jobs, execution state, and an outbox for status and final replies. The scheduler runs one Codex turn at a time per topic while allowing configured concurrency across topics.

Each topic has a workspace and a persisted Codex session ID. A reply in that topic resumes the session. Status cards are projections of SQLite state. The delivery worker retries pending outbox items with stable identifiers.

On restart, queued jobs remain queued. Jobs interrupted while preparing or running become terminal `interrupted` jobs; they are never replayed automatically because a previous turn may have changed external state. The gateway continues pending reply delivery.

The gateway alone holds the Feishu application credentials. Codex receives an explicit environment allowlist. Group turns use a workspace-write sandbox inside a separate user, mount, and PID namespace; private chat turns use unrestricted Codex permissions under the dedicated service account.
