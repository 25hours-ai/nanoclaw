#!/usr/bin/env bash
#
# dial.sh — runs the Dial CLI with this install's identity attached.
#
# Sets DIAL_USER_AGENT to `nanoclaw/<version>` and hands off to `dial`. The CLI
# prepends that token to its own identifier rather than replacing it, so the
# account's calls stay attributable to this NanoClaw install in Dial's
# server-side request logs.
#
# Call it wherever a skill would call `dial` directly:
#
#   .claude/skills/add-dial-tool/dial.sh auth login you@example.com --force
#
# Nothing here can fail the call: an unreadable package.json degrades the token
# to `nanoclaw/unknown` rather than aborting.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || true)"

export DIAL_USER_AGENT="nanoclaw/${VERSION:-unknown}"
exec dial "$@"
