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
#      Then scope it: `--agents <id,id>` names the NanoClaw agent groups that may
#      use Dial. Every other agent gets an OneCLI block rule for api.getdial.ai
#      (and the secret is not assigned to it), so only the chosen agents can
#      text, call or buy numbers on the account. `--agents all` keeps it open.
#   5. Rebuild the agent image (only when the manifest changed) and stop running
#      agent containers so they respawn on the new image with the CLI + skill.
#
# Interactive authentication (`dial auth login <email>` + `dial auth verify-otp --code`) is
# intentionally NOT here — the caller runs it (see SKILL.md), which writes the
# host auth.json this script reads on the next run.
#
# Usage: add.sh [--agents <agent-group-id>[,<id>...] | --agents all | --agents none]
#   --agents  Which NanoClaw agent groups may use Dial (ids from `ncl groups list`).
#             `all` opens every group, `none` blocks every group. Unset = all
#             (the historical behaviour); an EMPTY value is an error, never
#             "everyone". The /add-dial-tool skill always asks the operator and
#             passes this explicitly.
#
# Emits exactly one status block (ADD_DIAL_TOOL) on stdout; progress → stderr.
set -euo pipefail

AGENTS_ARG="${DIAL_TOOL_AGENTS-__unset__}"
while [ $# -gt 0 ]; do
  case "$1" in
    --agents) [ $# -ge 2 ] || { echo "--agents needs a value (ids, all, or none)" >&2; exit 2; }; AGENTS_ARG="$2"; shift 2 ;;
    --agents=*) AGENTS_ARG="${1#--agents=}"; shift ;;
    -h|--help) sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$AGENTS_ARG" = "__unset__" ] && AGENTS_ARG=all
# Normalise: strip whitespace, drop empties, dedupe, keep order.
AGENTS_ARG=$(printf '%s' "$AGENTS_ARG" | tr ',' '\n' | tr -d ' \t\r' | sed '/^$/d' | awk '!seen[$0]++' | paste -sd ',' -)

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_ROOT"

# Keep the pin in sync with the SKILL.md version note.
CLI_VERSION="0.37.0"
SKILL_SRC=".claude/skills/add-dial-tool/container-skills/dial-cli"
AUTH_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/dial/auth.v1.json"

log() { echo "[add-dial-tool] $*" >&2; }
CLI_ADDED=false
CREDENTIAL=none
AGENTS_ALLOWED=""
AGENTS_BLOCKED=""
RULE_PREFIX="Dial: blocked for "

emit() {
  echo "=== NANOCLAW SETUP: ADD_DIAL_TOOL ==="
  echo "STATUS: $1"
  echo "CLI_VERSION: ${CLI_VERSION}"
  echo "CREDENTIAL: ${CREDENTIAL}"
  echo "CLI_ADDED: ${CLI_ADDED}"
  echo "AGENTS: ${AGENTS_ARG:-<empty>}"
  echo "AGENTS_ALLOWED: ${AGENTS_ALLOWED:-none}"
  echo "AGENTS_BLOCKED: ${AGENTS_BLOCKED:-none}"
  [ -n "${2:-}" ] && echo "ERROR: $2"
  echo "=== END ==="
}

# Scope the Dial secret to the chosen agents. NanoClaw gives every agent group
# its own OneCLI agent whose identifier is the group id. The one switch used
# here is a per-agent block rule on api.getdial.ai:
#   allowed  → our block rule (if any) removed
#   blocked  → our block rule present and enabled
# Secret lists are left alone, with one exception: an agent already in
# `selective` mode only gets what is on its list, so an ALLOWED selective agent
# has the Dial secret merged in. `onecli agents set-secrets` SWITCHES an agent
# to selective mode, so it is never called on an `all`-mode agent: that would
# silently cut the agent off from every credential not on its list. (The
# pre-picker installer did exactly that to every agent on the install.)
# The OneCLI "default" agent is not a NanoClaw group and is left as it is.
# Agents created AFTER this run start in `all` mode with no rule, so they HAVE
# Dial until the operator re-runs with --agents.
scope_agents() {
  local sid="$1"
  local groups agents allowed_csv
  groups=$(ncl groups list --json 2>/dev/null | jq -c '[.data[] | {id, name}]' 2>/dev/null) \
    || { emit failed "could not list agent groups (\`ncl groups list --json\`) — is the NanoClaw host running?"; exit 1; }
  agents=$(onecli agents list 2>/dev/null | jq -c '[.data[] | {id, identifier, name, secretMode}]' 2>/dev/null) \
    || { emit failed "could not list OneCLI agents (\`onecli agents list\`)"; exit 1; }

  case "$AGENTS_ARG" in
    "") emit failed "--agents is empty: pass agent group ids, \`all\`, or \`none\`"; exit 1 ;;
    all) allowed_csv=$(printf '%s' "$groups" | jq -r '[.[].id] | join(",")'); log "scoping: every agent group may use Dial" ;;
    none) allowed_csv=""; log "scoping: no agent group may use Dial" ;;
    *)
      case ",$AGENTS_ARG," in *,all,*|*,none,*) emit failed "--agents: \`all\`/\`none\` cannot be mixed with ids"; exit 1 ;; esac
      allowed_csv="$AGENTS_ARG"
      # Every requested id must be a real agent group; a typo must not silently open or close anything.
      for want in $(printf '%s' "$allowed_csv" | tr ',' ' '); do
        printf '%s' "$groups" | jq -e --arg id "$want" '.[] | select(.id==$id)' >/dev/null 2>&1 \
          || { emit failed "--agents names unknown agent group '${want}' (see \`ncl groups list\`)"; exit 1; }
      done ;;
  esac

  # Only OUR rules (name-prefixed, host-wide, no path/method) are read or written;
  # an operator's own rules on api.getdial.ai are left alone.
  local rules
  rules=$(onecli rules list 2>/dev/null | jq -c --arg p "$RULE_PREFIX" \
    '[.data[] | select(.hostPattern=="api.getdial.ai" and .action=="block" and (.name | startswith($p)) and ((.pathPattern // "")=="") and ((.method // "")==""))]' 2>/dev/null) \
    || { emit failed "could not list OneCLI rules"; exit 1; }

  local gid gname aid mode cur merged rid renabled
  for gid in $(printf '%s' "$groups" | jq -r '.[].id'); do
    gname=$(printf '%s' "$groups" | jq -r --arg id "$gid" '.[] | select(.id==$id) | .name')
    aid=$(printf '%s' "$agents" | jq -r --arg id "$gid" '.[] | select(.identifier==$id) | .id' | head -1)
    mode=$(printf '%s' "$agents" | jq -r --arg id "$gid" '.[] | select(.identifier==$id) | .secretMode // "all"' | head -1)
    if [ -z "$aid" ]; then
      # No OneCLI agent yet: NanoClaw creates one (all mode) on the group's first
      # spawn. A blocked group needs its rule to exist before then, so create the
      # agent now exactly as the runtime would. Its mode is `all`: never touch its secrets.
      aid=$(onecli agents create --name "$gname" --identifier "$gid" 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)
      mode=all
      [ -n "$aid" ] || { emit failed "no OneCLI agent for ${gname} (${gid}) and could not create one"; exit 1; }
    fi
    rid=$(printf '%s' "$rules" | jq -r --arg a "$aid" '.[] | select(.agentId==$a) | .id' | head -1)
    renabled=$(printf '%s' "$rules" | jq -r --arg a "$aid" '.[] | select(.agentId==$a) | .enabled' | head -1)

    if printf ',%s,' "$allowed_csv" | grep -q ",${gid},"; then
      if [ "$mode" = selective ]; then
        cur=$(onecli agents secrets --id "$aid" 2>/dev/null | jq -r '[.data[]] | join(",")' 2>/dev/null || true)
        merged=$(printf '%s' "${cur},${sid}" | tr ',' '\n' | sed '/^$/d' | sort -u | paste -sd ',' -)
        onecli agents set-secrets --id "$aid" --secret-ids "$merged" >&2 2>/dev/null \
          || { emit failed "could not assign the Dial secret to ${gname} (${gid})"; exit 1; }
      fi
      if [ -n "$rid" ]; then
        onecli rules delete --id "$rid" >&2 2>/dev/null || { emit failed "could not remove the block rule for ${gname} (${gid})"; exit 1; }
        log "unblocked Dial for ${gname} (${gid})"
      fi
      AGENTS_ALLOWED="${AGENTS_ALLOWED:+${AGENTS_ALLOWED},}${gid}"
    else
      # Secret list untouched on purpose: the rule alone blocks, in either mode.
      if [ -z "$rid" ]; then
        onecli rules create --name "${RULE_PREFIX}${gname}" --host-pattern api.getdial.ai --action block \
          --agent-id "$aid" --enabled >&2 2>/dev/null \
          || { emit failed "could not create the OneCLI block rule for ${gname} (${gid})"; exit 1; }
        log "blocked Dial for ${gname} (${gid})"
      elif [ "$renabled" != true ]; then
        onecli rules update --id "$rid" --enabled true >&2 2>/dev/null \
          || { emit failed "could not re-enable the OneCLI block rule for ${gname} (${gid})"; exit 1; }
        log "re-enabled the Dial block for ${gname} (${gid})"
      fi
      AGENTS_BLOCKED="${AGENTS_BLOCKED:+${AGENTS_BLOCKED},}${gid}"
    fi
  done
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
  # Upsert, never create-if-absent. The vault is keyed by NAME, so an existing
  # "Dial API" secret is not necessarily this account's: re-onboarding, switching
  # accounts or rotating the key all leave a secret whose value points at the
  # PREVIOUS account. Skipping the write there leaves the sandboxed agent
  # authenticated as someone else — it lists that account's numbers and refuses
  # to use the line this install just wired, reporting it as missing rather than
  # as an auth problem. Always write the key the host is signed in with.
  SID=$(onecli secrets list 2>/dev/null | jq -r '.data[] | select(.name | test("(?i)dial")) | .id' | head -1 || true)
  if [ -n "$SID" ]; then
    log "updating the Dial secret in OneCLI to this account's key"
    onecli secrets update --id "$SID" --value "$KEY" \
      --host-pattern "api.getdial.ai" >&2 \
      || { emit failed "onecli secrets update failed"; exit 1; }
  else
    log "creating the Dial secret in OneCLI (host-pattern api.getdial.ai)"
    onecli secrets create --name "Dial API" --type generic --value "$KEY" \
      --host-pattern "api.getdial.ai" --header-name "Authorization" --value-format "Bearer {value}" >&2 \
      || { emit failed "onecli secrets create failed"; exit 1; }
    SID=$(onecli secrets list 2>/dev/null | jq -r '.data[] | select(.name | test("(?i)dial")) | .id' | head -1 || true)
  fi
  if [ -n "$SID" ]; then
    scope_agents "$SID"
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
