# Architecture

The gateway receives Feishu WebSocket events, validates the configured chats, and binds each message to a topic. A SQLite database stores topic bindings, FIFO jobs, execution state, and an outbox for status and final replies. The scheduler runs one Codex turn at a time per topic while allowing configured concurrency across topics.

Each topic has a workspace and a persisted Codex session ID. A reply in that topic resumes the session. Status cards are projections of SQLite state. The delivery worker retries pending outbox items with stable identifiers.

The first final-reply chunk updates the existing status card. A successful update API response acknowledges delivery, after which the card's message ID is saved as the final delivery receipt. Feishu's message read API returns rendered text with normalized Markdown and whitespace; this lossy representation must not be compared byte-for-byte with the original reply or invalidate an acknowledged delivery. Later status retries preserve that result, including after restart and payload cleanup. Additional chunks remain ordered text replies; failure of a later chunk adds a delivery warning without erasing the first chunk. Missing or permanently uneditable cards, and payloads exceeding the serialized card request limit, use the existing text-reply fallback. Transient card update failures retry the same card without creating another message.

On restart, queued jobs remain queued. Jobs interrupted while preparing or running become terminal `interrupted` jobs; they are never replayed automatically because a previous turn may have changed external state. The gateway continues pending reply delivery.

The gateway alone holds the Feishu application credentials. Codex receives an explicit environment allowlist. Group turns use a workspace-write sandbox inside a separate user, mount, and PID namespace; private chat turns use unrestricted Codex permissions under the dedicated service account.

## Oncall mode

Setting `ONCALL_CONFIG_PATH` selects `OncallIngress`; the legacy ingress remains available without it. Both private and group conversations bind `(chat_id, root_message_id)` to one persistent topic/session and an immutable business workspace. Ordinary topic messages add context; only a mention (including a mention without extra text), explicit continuation or workspace-switch command creates work. Replies always use Feishu's topic reply API.

SQLite schema v12 adds workspace bindings, frozen-boundary source messages, pause/resume state and workspace-scoped cases. Input preparation writes attachments and the complete context to topic files, with at most 100 message previews in the prompt. Missing history or downloads are reported as gaps. Successful downloads are cached by message and resource identity. The gateway performs transport and persistence; investigation strategy and explicit-action authorization belong to the Oncall Agent instructions.

The scheduler defaults to five concurrent topics, serializes each topic, and prioritizes its explicit recovery job before retained queued jobs. Stop pauses the topic before aborting its running job. Failure, service shutdown and restart recovery also persist a pause and refresh queued status deliveries. Ordinary mentions do not unpause. Recovery first checks prior external effects; it does not replay interrupted jobs. Cases are updated in actual completion order and keep an idempotent history per job. Missing case output does not erase an existing case.

Oncall runs unrestricted Codex inside its dedicated nonprivileged Docker container for both chat types. It does not use the legacy `unshare` wrapper. A separate POSIX process group receives TERM and then KILL when cancelled, covering tools that inherit that group. Explicit environment allowlisting excludes the gateway app credentials; configured tool login files remain in dedicated persistent storage. Normal work has no total timeout. The Oncall skill handles repeated tool errors by seeking evidence or reporting a blocker, rather than retrying indefinitely.

Oncall topic directories and jobs are excluded from legacy pruning so restart recovery, local evidence and shared cases survive. No automatic Oncall archive deletion policy is implemented. Real Feishu permissions and private/group topic behavior require deployment acceptance; simulated event tests cannot establish them.

Schema v13 adds per-topic backend sessions. Administrator model selection lives in `service_metadata.agent_settings`; the gateway owns writes and each execution captures one selection. Legacy session ownership remains in `agent_backend`, so old Codex session IDs are never sent to TRAE. Web data reads retain a separate read-only connection; only the authenticated model-settings endpoint calls the gateway's settings control.
