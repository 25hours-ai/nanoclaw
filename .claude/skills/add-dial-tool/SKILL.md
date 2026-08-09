---
name: add-dial-tool
description: Give NanoClaw agents a real phone number as a container tool — the `dial` CLI baked into the agent image plus OneCLI credential injection for api.getdial.ai, so any agent can send SMS, place AI voice calls, and receive verification codes from inside the sandbox. Independent of the Dial channel; idempotent. Use when the user wants agents to text, call, or run `dial …` from a chat, without wiring Dial as a messaging channel.
---

# Add Dial Tool

Installs Dial as a **container tool**: the `dial` CLI on the agent's `PATH`, the `dial-cli` skill so the agent knows how to drive it, and an OneCLI credential so in-container calls are injected keyless. Independent of the Dial **channel** (`/add-dial`) — install this alone. Idempotent.

**Run from your host `claude` session in the NanoClaw repo** (not from a chat with the agent — the container can't install itself).

The deterministic work lives in **`add.sh`** (reused by the setup wizard). This skill only handles the one interactive part: getting a Dial API key when the host has none.

## Phase 1: Pre-flight

OneCLI is required for credential injection:

```bash
onecli version 2>/dev/null && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry. Stop here.

## Phase 2: Install (deterministic)

Run the installer. It installs the pinned `dial` CLI on the host if missing, idempotently adds `@getdial/cli` to `container/cli-tools.json`, mounts the `dial-cli` skill, registers the OneCLI credential **if** the host `auth.json` exists (written by `dial auth login`/`dial auth verify-otp`), rebuilds the image, and restarts running containers:

```bash
bash .claude/skills/add-dial-tool/add.sh
```

Read its `ADD_DIAL_TOOL` status block:

- **`CREDENTIAL: set`** — done. Skip to **Done**.
- **`CREDENTIAL: none`** — no Dial key was found on this host. Continue to Phase 3 to mint one.

## Phase 3: Authenticate on the host (only if `CREDENTIAL: none`)

`add.sh` already installed the pinned `dial` CLI on the host. Authenticate with it — this writes the host `auth.json` that `add.sh` reads. Ask the user for an email:

```bash
.claude/skills/add-dial-tool/dial.sh auth login "$EMAIL" --force   # emails a 6-digit code
```

Ask the user for the code, then verify it. Do **not** pass `--agent` — this skill owns the container `dial-cli` skill, and `--agent nanoclaw` would inject a second, unmanaged copy:

```bash
.claude/skills/add-dial-tool/dial.sh auth verify-otp --code "$CODE"
```

Re-run the installer — it now reads the key from the host `auth.json` and registers it with OneCLI:

```bash
bash .claude/skills/add-dial-tool/add.sh
```

## Done

Any agent can now use Dial from inside its container. Auth is injected by OneCLI; a `401`/`403` means the Dial secret needs (re)connecting or assigning — not a login. Verify from a chat with a wired agent: "run dial doctor" or "text +1… hi".

To uninstall: `bash .claude/skills/add-dial-tool/remove.sh` (see `REMOVE.md`). To wire Dial as a **messaging channel** too, run `/add-dial`.
