# Remove Dial Tool

Reverses `/add-dial-tool`. Every step is idempotent — safe to re-run, and safe
when only partially installed (skip any step whose target is already absent).
Removes the **tool** only — it does not touch the Dial **channel** (`/add-dial`).

## 1. Remove the CLI from the agent image manifest

Delete the `@getdial/cli` entry from `container/cli-tools.json`, keeping the
top-level array valid:

```bash
tmp=$(mktemp) && jq 'map(select(.name != "@getdial/cli"))' container/cli-tools.json > "$tmp" && mv "$tmp" container/cli-tools.json
```

## 2. Remove the container skill and its per-session copies

```bash
rm -rf container/skills/dial-cli
for s in data/v2-sessions/ag-*/.claude-shared/skills/dial-cli; do rm -rf "$s"; done
```

## 3. Remove the OneCLI credential and the per-agent block rules

Deleting the secret is what revokes access for every agent. Per-agent secret
lists are not edited (`set-secrets` would switch an `all`-mode agent to
`selective` and cut it off from its other secrets). The block rules this skill
created are name-prefixed, so only those go — an operator's own rules on
`api.getdial.ai` stay:

```bash
for id in $(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)dial")) | .id'); do onecli secrets delete --id "$id"; done
for id in $(onecli rules list | jq -r '.data[] | select(.hostPattern=="api.getdial.ai" and .action=="block" and (.name | startswith("Dial: blocked for "))) | .id'); do onecli rules delete --id "$id"; done
```

## 4. Rebuild and restart the agents

Rebuild the image so it matches the manifest, then stop running agent
containers so they respawn without the CLI:

```bash
./container/build.sh
docker ps --filter label=nanoclaw-container-name -q | xargs -r docker stop
```

The Dial account, its numbers, and the host `dial` CLI are managed by Dial, not
NanoClaw — `npm uninstall -g @getdial/cli` on the host if you no longer want it.
