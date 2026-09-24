#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${INSTALL_ROOT:-}"
STATE_ROOT="${STATE_ROOT:-}"
ENV_FILE="${ENV_FILE:-}"
UNIT_FILE="${UNIT_FILE:-}"
SERVICE_USER="${SERVICE_USER:-feishu-codex}"
SERVICE_GROUP="${SERVICE_GROUP:-${SERVICE_USER}}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NOLOGIN_BIN="${NOLOGIN_BIN:-$(command -v nologin || true)}"

for command_name in realpath pnpm unshare systemctl groupadd useradd getent install sed mktemp mv cp rm; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required" >&2
    exit 1
  fi
done

require_safe_path() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" || "${value}" != /* || "${value}" == "/" ]]; then
    echo "${name} must be a non-root absolute path" >&2
    exit 1
  fi
  if [[ "$(realpath -m -- "${value}")" != "${value}" ]]; then
    echo "${name} must be normalized" >&2
    exit 1
  fi
  if [[ "${value}" =~ [[:space:]@\|\&] ]]; then
    echo "${name} contains unsupported characters" >&2
    exit 1
  fi
}

require_safe_path "INSTALL_ROOT" "${INSTALL_ROOT}"
require_safe_path "STATE_ROOT" "${STATE_ROOT}"
require_safe_path "ENV_FILE" "${ENV_FILE}"
require_safe_path "UNIT_FILE" "${UNIT_FILE}"
require_safe_path "NODE_BIN" "${NODE_BIN}"
require_safe_path "NOLOGIN_BIN" "${NOLOGIN_BIN}"

AGENT_HOME="${STATE_ROOT}/codex-home"

if [[ ! "${SERVICE_USER}" =~ ^[a-z_][a-z0-9_-]*$ || ! "${SERVICE_GROUP}" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "SERVICE_USER and SERVICE_GROUP must be valid system identity names" >&2
  exit 1
fi

require_disjoint() {
  local left="$1"
  local right="$2"
  if [[ "${left}" == "${right}" || "${left}" == "${right}"/* || "${right}" == "${left}"/* ]]; then
    echo "Install, state, environment, and unit locations must not overlap" >&2
    exit 1
  fi
}

require_disjoint "${INSTALL_ROOT}" "${STATE_ROOT}"
require_disjoint "${INSTALL_ROOT}" "${ENV_FILE}"
require_disjoint "${STATE_ROOT}" "${ENV_FILE}"
require_disjoint "${INSTALL_ROOT}" "${UNIT_FILE}"
require_disjoint "${STATE_ROOT}" "${UNIT_FILE}"
require_disjoint "${ENV_FILE}" "${UNIT_FILE}"

if [[ "${INSTALL_ROOT}" == "${PROJECT_ROOT}" || "${INSTALL_ROOT}" == "${PROJECT_ROOT}"/* || "${PROJECT_ROOT}" == "${INSTALL_ROOT}"/* ]]; then
  echo "INSTALL_ROOT must be separate from the source checkout" >&2
  exit 1
fi

if [[ ! -x "${NODE_BIN}" || "$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')" != "22" ]]; then
  echo "The service requires Node.js 22" >&2
  exit 1
fi
if [[ ! -x "${NOLOGIN_BIN}" ]]; then
  echo "A nologin executable is required" >&2
  exit 1
fi

if [[ -L "${ENV_FILE}" || ! -f "${ENV_FILE}" || "$(realpath -e -- "${ENV_FILE}")" != "${ENV_FILE}" ]]; then
  echo "ENV_FILE must be an existing regular file without symbolic-link traversal" >&2
  exit 1
fi
if [[ -L "${UNIT_FILE}" ]]; then
  echo "UNIT_FILE cannot be a symbolic link" >&2
  exit 1
fi
if [[ -e "${UNIT_FILE}" && ! -f "${UNIT_FILE}" ]]; then
  echo "UNIT_FILE must be a regular file" >&2
  exit 1
fi
if [[ ! -d "$(dirname "${UNIT_FILE}")" ]]; then
  echo "UNIT_FILE parent directory does not exist" >&2
  exit 1
fi

unit_name="$(basename "${UNIT_FILE}")"
if systemctl is-active --quiet "${unit_name}"; then
  echo "Refusing to update an active service; stop ${unit_name} first" >&2
  exit 1
fi

for managed_path in \
  "${INSTALL_ROOT}" \
  "${STATE_ROOT}" \
  "${AGENT_HOME}" \
  "${AGENT_HOME}/skills" \
  "${STATE_ROOT}/workspaces"; do
  if [[ -L "${managed_path}" ]]; then
    echo "Refusing symbolic link at managed path: ${managed_path}" >&2
    exit 1
  fi
done

chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

cd "${PROJECT_ROOT}"
pnpm install --frozen-lockfile
pnpm build

if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${SERVICE_GROUP}"
fi
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_GROUP}" --home-dir "${STATE_ROOT}" --create-home --shell "${NOLOGIN_BIN}" "${SERVICE_USER}"
fi

service_home="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
service_shell="$(getent passwd "${SERVICE_USER}" | cut -d: -f7)"
service_group="$(id -gn "${SERVICE_USER}")"
if [[ "${service_home}" != "${STATE_ROOT}" || "${service_shell}" != "${NOLOGIN_BIN}" || "${service_group}" != "${SERVICE_GROUP}" ]]; then
  echo "Existing service identity does not match the configured home, shell, or primary group" >&2
  exit 1
fi

install_parent="$(dirname "${INSTALL_ROOT}")"
install_name="$(basename "${INSTALL_ROOT}")"
install -d -o root -g root -m 0755 "${install_parent}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 \
  "${STATE_ROOT}" "${AGENT_HOME}" "${STATE_ROOT}/workspaces"

if [[ "$(realpath -e -- "${install_parent}")" != "${install_parent}" || "$(realpath -e -- "${STATE_ROOT}")" != "${STATE_ROOT}" ]]; then
  echo "Managed directories cannot traverse symbolic links" >&2
  exit 1
fi
if [[ -e "${INSTALL_ROOT}" && ( ! -d "${INSTALL_ROOT}" || "$(realpath -e -- "${INSTALL_ROOT}")" != "${INSTALL_ROOT}" ) ]]; then
  echo "INSTALL_ROOT must be a real directory" >&2
  exit 1
fi

staging_root="$(mktemp -d "${install_parent}/.${install_name}.staging.XXXXXX")"
backup_container=""
unit_tmp=""
unit_backup=""
unit_existed=0
rollback_required=0

cleanup_install() {
  local exit_status=$?
  trap - EXIT
  if [[ "${exit_status}" -ne 0 && "${rollback_required}" -eq 1 ]]; then
    if [[ -e "${INSTALL_ROOT}" && ! -L "${INSTALL_ROOT}" ]]; then
      rm -rf -- "${INSTALL_ROOT}"
    fi
    if [[ -n "${backup_container}" && -d "${backup_container}/previous" ]]; then
      mv -- "${backup_container}/previous" "${INSTALL_ROOT}"
    fi
    if [[ "${unit_existed}" -eq 1 && -n "${unit_backup}" && -f "${unit_backup}" ]]; then
      cp -a -- "${unit_backup}" "${UNIT_FILE}"
    elif [[ "${unit_existed}" -eq 0 ]]; then
      rm -f -- "${UNIT_FILE}"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [[ -n "${staging_root}" && -d "${staging_root}" ]]; then
    rm -rf -- "${staging_root}"
  fi
  if [[ -n "${backup_container}" && -d "${backup_container}" ]]; then
    rm -rf -- "${backup_container}"
  fi
  if [[ -n "${unit_tmp}" ]]; then rm -f -- "${unit_tmp}"; fi
  if [[ -n "${unit_backup}" ]]; then rm -f -- "${unit_backup}"; fi
  exit "${exit_status}"
}
trap cleanup_install EXIT

cp -a dist src package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json scripts workspace-template "${staging_root}/"
chmod 0755 "${staging_root}/scripts/codex-isolated.sh"
install -d -o root -g root -m 0755 "${staging_root}/node_modules"
cp -a node_modules/. "${staging_root}/node_modules/"
chown -R root:root "${staging_root}"
chmod -R a-w "${staging_root}"
chmod 0555 "${staging_root}"
"${NODE_BIN}" --check "${staging_root}/dist/main.js"
"${NODE_BIN}" "${staging_root}/dist/status.js" --help >/dev/null

unit_tmp="$(mktemp "${UNIT_FILE}.tmp.XXXXXX")"
sed \
  -e "s|@SERVICE_USER@|${SERVICE_USER}|g" \
  -e "s|@SERVICE_GROUP@|${SERVICE_GROUP}|g" \
  -e "s|@INSTALL_ROOT@|${INSTALL_ROOT}|g" \
  -e "s|@STATE_ROOT@|${STATE_ROOT}|g" \
  -e "s|@ENV_FILE@|${ENV_FILE}|g" \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  deploy/feishu-codex-bot.service.in >"${unit_tmp}"

unit_backup="$(mktemp "${UNIT_FILE}.backup.XXXXXX")"
if [[ -f "${UNIT_FILE}" ]]; then
  cp -a -- "${UNIT_FILE}" "${unit_backup}"
  unit_existed=1
else
  rm -f -- "${unit_backup}"
fi

backup_container="$(mktemp -d "${install_parent}/.${install_name}.backup.XXXXXX")"
rollback_required=1
if [[ -d "${INSTALL_ROOT}" ]]; then
  mv -- "${INSTALL_ROOT}" "${backup_container}/previous"
fi
mv -- "${staging_root}" "${INSTALL_ROOT}"
staging_root=""
install -o root -g root -m 0644 "${unit_tmp}" "${UNIT_FILE}"
systemctl daemon-reload
rollback_required=0
echo "Installed. Complete login and preflight before starting the service."
