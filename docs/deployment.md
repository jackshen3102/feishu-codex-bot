# Linux deployment

The installer targets Linux with systemd, Node.js 22, pnpm, and user namespaces. Install Codex for the dedicated service user before starting the bot.

Set these shell variables to normalized, nonoverlapping absolute paths:

```bash
export INSTALL_ROOT="<program-directory>"
export STATE_ROOT="<state-directory>"
export ENV_FILE="<root-readable-environment-file>"
export UNIT_FILE="<systemd-unit-file>"
export SERVICE_USER="feishu-codex"
export SERVICE_GROUP="feishu-codex"
```

Create `ENV_FILE` with the variables in [configuration](configuration.md), owned by root with mode `0600`. Run the installer from the repository root:

```bash
sudo env INSTALL_ROOT="$INSTALL_ROOT" STATE_ROOT="$STATE_ROOT" \
  ENV_FILE="$ENV_FILE" UNIT_FILE="$UNIT_FILE" \
  SERVICE_USER="$SERVICE_USER" SERVICE_GROUP="$SERVICE_GROUP" \
  ./scripts/install.sh
```

Log in to Codex as the service user with `HOME="$STATE_ROOT"` and `CODEX_HOME="$STATE_ROOT/codex-home"`. Run `pnpm preflight` under that same identity and environment while the service is stopped. Then enable and start the installed systemd unit.

Before updating, stop the unit and back up the SQLite database together with any WAL files. Reinstall using the same paths and run preflight before restarting. An interrupted running job is reported as interrupted after restart and is never rerun automatically.
