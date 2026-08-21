---
name: add-dial-tool
description: Give chosen NanoClaw agents a real phone number as a container tool — the `dial` CLI baked into the agent image plus OneCLI credential injection for api.getdial.ai, scoped per agent, so the agents you pick can send SMS, place AI voice calls, and receive verification codes from inside the sandbox. Independent of the Dial channel; idempotent; re-run to change which agents may use it. Use when the user wants agents to text, call, or run `dial …` from a chat, without wiring Dial as a messaging channel.
---

# Add Dial Tool

Installs Dial as a **container tool**: the `dial` CLI on the agent's `PATH`, the `dial-cli` skill so the agent knows how to drive it, and an OneCLI credential so in-container calls are injected keyless. Independent of the Dial **channel** (`/add-dial`) — install this alone. Idempotent.

**This tool spends money and reaches real people.** An agent with Dial access can text and call any number and buy more numbers, billed to the Dial account. The CLI and the skill file land in every agent's container, but the **key** is injected per agent by OneCLI, so the operator chooses which agents get it (Phase 2). Everyone else gets a block rule and sees `403 blocked_by_policy` if it tries.

**Run from your host `claude` session in the NanoClaw repo** (not from a chat with the agent — the container can't install itself).

The deterministic work lives in **`add.sh`**. This skill handles the two interactive parts: choosing which agents may use Dial, and getting a Dial API key when the host has none.

## Phase 1: Pre-flight

OneCLI is required for credential injection:

```bash
onecli version 2>/dev/null && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry. Stop here.

## Phase 2: Choose which agents may use Dial

List the agent groups:

```bash
ncl groups list
```

Ask the operator which of them may use Dial, as a multi-select over the agent names. Say plainly what they are granting: *texting and calling any number, and buying numbers, billed to your Dial account.* Ask even when there is a single agent (yes/no). Two things to tell them:

- Agents created **after** this run **will have Dial** until `/add-dial-tool` is run again: a new agent starts with access to every credential in the vault. Re-running is idempotent and only touches the per-agent rules.
- Nothing is deleted for agents left out — they get an OneCLI block rule for `api.getdial.ai`, reversible by re-running. Their other credentials are untouched.

Keep the chosen ids (the `id` column, `ag-…`) for the next phase. If the operator wants every agent, use `all`. If they select **no** agent, use `none` (the tool installs, every agent is blocked, and they can re-run later). Never pass an empty value.

## Phase 3: Install (deterministic)

Run the installer with the choice. It installs the pinned `dial` CLI on the host if missing, idempotently adds `@getdial/cli` to `container/cli-tools.json`, mounts the `dial-cli` skill, registers the OneCLI credential **if** the host `auth.json` exists (written by `dial auth login`/`dial auth verify-otp`), scopes it to the chosen agents, rebuilds the image, and restarts running containers:

```bash
bash .claude/skills/add-dial-tool/add.sh --agents ag-…,ag-…   # or --agents all
```

Read its `ADD_DIAL_TOOL` status block:

- **`CREDENTIAL: set`** — done; `AGENTS_ALLOWED` / `AGENTS_BLOCKED` list what was scoped. Skip to **Done**.
- **`CREDENTIAL: none`** — no Dial key was found on this host. Continue to Phase 4 to mint one.

## Phase 4: Authenticate on the host (only if `CREDENTIAL: none`)

`add.sh` already installed the pinned `dial` CLI on the host. Authenticate with it — this writes the host `auth.json` that `add.sh` reads. Ask the user for an email:

```bash
.claude/skills/add-dial-tool/dial.sh auth login "$EMAIL" --force   # emails a 6-digit code
```

Ask the user for the code, then verify it. Do **not** pass `--agent` — this skill owns the container `dial-cli` skill, and `--agent nanoclaw` would inject a second, unmanaged copy:

```bash
.claude/skills/add-dial-tool/dial.sh auth verify-otp --code "$CODE"
```

Re-run the installer with the same `--agents` choice — it now reads the key from the host `auth.json`, registers it with OneCLI and scopes it:

```bash
bash .claude/skills/add-dial-tool/add.sh --agents ag-…,ag-…
```

## Done

The chosen agents can now use Dial from inside their containers; the others are blocked at the gateway. Auth is injected by OneCLI; a `403 blocked_by_policy` means the agent was not chosen (re-run to change); a `401` means the Dial secret needs (re)connecting — not a login. Verify from a chat with a chosen agent: "run dial doctor" or "text +1… hi".

To uninstall: `bash .claude/skills/add-dial-tool/remove.sh` (see `REMOVE.md`). To wire Dial as a **messaging channel** too, run `/add-dial`.
