#!/usr/bin/env bash
#
# Non-interactive installer for the Dial container tool. Idempotent + reusable
# (by the /add-dial-tool skill now, and the setup wizard later). Does ONLY the
# deterministic steps — no prompts:
#
#   1. Install the pinned `dial` CLI on the HOST if missing (needed to
#      authenticate; `dial auth login`/`verify-otp` write the host auth.json).
#   2. Idempotently add @getdial/cli (pinned) to container/cli-tools.json.
#   3. Mount the dial-cli container skill into container/skills/ (+ live sessions).
#   4. Register the Dial API key with OneCLI (host-pattern api.getdial.ai) by
#      reading it from the HOST auth.json (the single source of truth, written by
#      `dial auth login`/`dial auth verify-otp`); else reports CREDENTIAL: none.
#   5. Rebuild the agent image (only when the manifest changed) and stop running
#      agent containers so they respawn on the new image with the CLI + skill.
#
# Interactive authentication (`dial auth login <email>` + `dial auth verify-otp --code`) is
# intentionally NOT here — the caller runs it (see SKILL.md), which writes the
# host auth.json this script reads on the next run.
#
# Emits exactly one status block (ADD_DIAL_TOOL) on stdout; progress → stderr.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_ROOT"

# Keep the pin in sync with the SKILL.md version note.
CLI_VERSION="0.37.0"
SKILL_SRC=".claude/skills/add-dial-tool/container-skills/dial-cli"
AUTH_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/dial/auth.v1.json"

log() { echo "[add-dial-tool] $*" >&2; }
CLI_ADDED=false
CREDENTIAL=none

emit() {
  echo "=== NANOCLAW SETUP: ADD_DIAL_TOOL ==="
  echo "STATUS: $1"
  echo "CLI_VERSION: ${CLI_VERSION}"
  echo "CREDENTIAL: ${CREDENTIAL}"
  echo "CLI_ADDED: ${CLI_ADDED}"
  [ -n "${2:-}" ] && echo "ERROR: $2"
  echo "=== END ==="
}

# 1. Ensure the pinned `dial` CLI is on the HOST (only if missing). It's needed
#    to authenticate — `dial auth login`/`dial auth verify-otp` write the host auth.json.
if ! command -v dial >/dev/null 2>&1; then
  log "installing the dial CLI on the host (npm i -g @getdial/cli@${CLI_VERSION})"
  npm install -g "@getdial/cli@${CLI_VERSION}" >&2 || { emit failed "failed to install the host dial CLI"; exit 1; }
fi

# 2. Ensure @getdial/cli is in the image manifest (pinned, idempotent).
if ! jq -e '.[] | select(.name=="@getdial/cli")' container/cli-tools.json >/dev/null 2>&1; then
  log "adding @getdial/cli@${CLI_VERSION} to container/cli-tools.json"
  tmp=$(mktemp)
  jq --arg v "$CLI_VERSION" '. + [{"name":"@getdial/cli","version":$v}]' container/cli-tools.json > "$tmp" && mv "$tmp" container/cli-tools.json
  CLI_ADDED=true
else
  log "@getdial/cli already in cli-tools.json — leaving the pin as-is"
fi

# 3. Mount the dial-cli container skill.
if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  emit failed "missing skill source ${SKILL_SRC}/SKILL.md"
  exit 1
fi
log "installing the dial-cli container skill"
mkdir -p container/skills/dial-cli
cp "$SKILL_SRC/SKILL.md" container/skills/dial-cli/SKILL.md
for s in data/v2-sessions/ag-*; do
  [ -d "$s/.claude-shared/skills" ] || continue
  rsync -a container/skills/ "$s/.claude-shared/skills/" 2>/dev/null || true
done

# 4. Register the credential with OneCLI from the HOST auth.json — the single
#    source of truth, written by `dial auth login`/`dial auth verify-otp`.
KEY=""
[ -f "$AUTH_FILE" ] && KEY=$(jq -r '.apiKey // empty' "$AUTH_FILE" 2>/dev/null || true)
if [ -n "$KEY" ]; then
  log "read Dial API key from ${AUTH_FILE}"
  command -v onecli >/dev/null 2>&1 || { emit failed "onecli not found — run /init-onecli first"; exit 1; }
  if onecli secrets list 2>/dev/null | grep -qi dial; then
    log "Dial secret already in the OneCLI vault"
  else
    log "creating the Dial secret in OneCLI (host-pattern api.getdial.ai)"
    onecli secrets create --name "Dial API" --type generic --value "$KEY" \
      --host-pattern "api.getdial.ai" --header-name "Authorization" --value-format "Bearer {value}" >&2 \
      || { emit failed "onecli secrets create failed"; exit 1; }
  fi
  SID=$(onecli secrets list 2>/dev/null | jq -r '.data[] | select(.name | test("(?i)dial")) | .id' | head -1 || true)
  if [ -n "$SID" ]; then
    for a in $(onecli agents list 2>/dev/null | jq -r '.data[].id' 2>/dev/null || true); do
      CUR=$(onecli agents secrets --id "$a" 2>/dev/null | jq -r '[.data[]] | join(",")' 2>/dev/null || true)
      M=$(printf '%s' "${CUR},${SID}" | tr ',' '\n' | sed '/^$/d' | sort -u | paste -sd ',' -)
      onecli agents set-secrets --id "$a" --secret-ids "$M" >&2 2>/dev/null || true
    done
  fi
  CREDENTIAL=set
else
  log "no host auth.json at ${AUTH_FILE} — authenticate with \`dial auth login\`/\`dial auth verify-otp\` (see SKILL.md), then re-run"
fi

# 5. Rebuild the image (only if the manifest changed) + restart running containers.
if [ "$CLI_ADDED" = true ]; then
  log "rebuilding the agent image so the CLI lands…"
  ./container/build.sh >&2
fi
log "stopping running agent containers so they respawn on the new image"
docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null | grep nanoclaw | awk '{print $1}' | xargs -r docker stop >/dev/null 2>&1 || true

emit success
