#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--feishu-isolated-child" ]]; then
  shift
  exec "${FEISHU_CODEX_BINARY}" --config 'features.shell_snapshot=false' "$@"
fi

unshare_bin="$(command -v unshare || true)"
if [[ -z "${unshare_bin}" || ! -x "${unshare_bin}" ]]; then
  echo "Codex isolation requires unshare." >&2
  exit 126
fi

real_codex="${FEISHU_CODEX_BINARY:-}"
if [[ -z "${real_codex}" || ! -x "${real_codex}" ]]; then
  echo "Bundled Codex CLI is unavailable." >&2
  exit 127
fi

isolation_pid=""
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
script_path="${script_directory}/$(basename -- "${BASH_SOURCE[0]}")"

terminate() {
  local status="$1"
  trap - HUP INT TERM
  if [[ -n "${isolation_pid}" ]] && kill -0 "${isolation_pid}" 2>/dev/null; then
    kill -KILL "${isolation_pid}" 2>/dev/null || true
  fi
  wait "${isolation_pid}" 2>/dev/null || true
  exit "${status}"
}

trap 'terminate 129' HUP
trap 'terminate 130' INT
trap 'terminate 143' TERM

"${unshare_bin}" \
  --user \
  --map-root-user \
  --mount \
  --pid \
  --fork \
  --kill-child=SIGKILL \
  --mount-proc \
  "${script_path}" --feishu-isolated-child "$@" <&0 &
isolation_pid="$!"

if wait "${isolation_pid}"; then
  exit 0
else
  exit "$?"
fi
