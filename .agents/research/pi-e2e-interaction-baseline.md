# Pi E2E Interaction Baseline

Baseline protocol for driving a non-interactive multi-turn `pi` session end-to-end, capturing its state, and verifying behaviour externally. Produced by reading source and running probing invocations against `./pi-test.sh` in `/home/basil/projects/context-bonsai-pi/`.

## TL;DR

**Recommended single-turn pattern** (deterministic, machine-parseable):

```bash
./pi-test.sh -p --mode json \
    --no-extensions \
    --session-dir /tmp/e2e/sess \
    "<prompt>"
```

- `--mode json` (with `-p`) streams every `AgentSessionEvent` as one JSON object per line to stdout (cf. `packages/coding-agent/src/modes/print-mode.ts:104`).
- `--session-dir` writes the JSONL session file to a path you control; no need to poke `~/.pi/agent/sessions/`.
- `--no-extensions` suppresses discovery-based loading of extensions; explicit `-e <path>` still works.
- `--no-tools` optional: safe for prompts where you don't need tool use.

**For multi-turn**, either `-c` (continues most recent in the session-dir) or `--session <path>` (pin an exact file; path may be new).

---

## 1. Non-interactive one-shot with structured output

### Flag comparison

| Flag combo | Stdout shape | Blocking? |
|---|---|---|
| `-p` (text, default) | Only final assistant text (newline-terminated). Errors -> stderr + exit 1. | No, exits when turn ends. |
| `-p --mode json` | JSONL stream of every `AgentSessionEvent`; first line is the `SessionHeader`. | No, exits when turn ends. |
| `--mode rpc` | JSONL; reads commands from stdin, emits events + responses. Keeps process alive until stdin closes / SIGTERM. | Yes — intended for persistent embedding. |

**Verdict**: `-p --mode json` is the right E2E primitive. You get every event deterministically, then the process exits. RPC is overkill for scripted tests; it's meant for embedding.

### Captured example (real run, 1 turn)

```
{"type":"session","version":3,"id":"019dbb15-7abf-761d-a63f-c5a04dbe33ca","timestamp":"2026-04-23T16:04:00.320Z","cwd":"/home/basil/projects/context-bonsai-pi"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"say hello in one word"}],"timestamp":...}}
{"type":"message_end","message":{"role":"user","content":[...]}}
{"type":"message_start","message":{"role":"assistant",...}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello",...}],...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

### `--no-tools` / `--no-extensions` with `-p`

Both work with `-p`. Confirmed by running:

```bash
./pi-test.sh -p --mode json --no-tools --no-extensions --session-dir /tmp/x "hi"
# → clean JSONL stream, no extension-load errors in stderr, no tools offered to the model.
```

### Avoiding API-key prompts when none are present

- `./pi-test.sh --no-env` (wrapper flag, see `pi-test.sh:7-54`) strips every provider API key env var, *but* pi still authenticates via `~/.pi/agent/auth.json` if it exists (OAuth tokens, e.g. `openai-codex`). On this box `--no-env -p ... "hi"` ran to completion via a stored codex token.
- There is no "fake model" flag. If you truly want no model call and just want to verify extension wiring, use `--mode rpc` and send commands like `get_state` / `get_commands` that don't need the model. These return immediately without prompting.
- `--no-tools` does **not** skip the model call. It disables tool registration only.
- Upshot: if you need a hermetic test that never hits a network, stage `~/.pi/agent/auth.json` out and unset all envs — pi will fail fast in `-p` with a non-interactive error. Otherwise, scope tests so they tolerate a real (cheap) model call.

---

## 2. Driving a multi-turn session without a TUI

### `-p -c "next message"`

- Continues the **most-recent** session in the effective `sessionDir` (cf. `main.ts:279-281`, `session-manager.ts:1295-1302`).
- If no prior session exists, it silently starts a new one — verified: `./pi-test.sh -p -c --session-dir /tmp/empty "hi"` succeeded with a fresh session.
- Caveat: "most recent" is by mtime of the `.jsonl` files in `sessionDir`. If multiple parallel tests share a dir, the loser's turn attaches to the winner's session.

### `--session <path>`

- Pins an exact session file (`main.ts:238-260`).
- **File may be new**: verified with `--session /tmp/.../fresh.jsonl` on a non-existent path; pi creates it and writes header + entries.
- The file may also be an existing session in the same or a different project (cwd prompt in TUI mode; `-p` with a global session errors out with the "session found in different project" path).
- If you only pass `--session` without `-p`, you enter interactive mode on that file.

### Two-invocation verification

```bash
DIR=/tmp/pi-e2e-demo; rm -rf "$DIR"; mkdir -p "$DIR"
./pi-test.sh -p --no-extensions --session-dir "$DIR" "say hello in one word"
FILE=$(ls "$DIR"/*.jsonl)
./pi-test.sh -p --no-extensions --session-dir "$DIR" --session "$FILE" "and now in spanish"
wc -l "$FILE"              # → 7 (header + model_change + thinking_level_change + 2 user + 2 assistant)
grep -c '"role":"user"' "$FILE"       # → 2
grep -c '"role":"assistant"' "$FILE"  # → 2
```

Confirmed.

---

## 3. Inspecting session state

### `--export <file>` writes HTML, not JSONL

`main.ts:459-471` + `core/export-html/index.ts:287` (`exportFromFile`) — always writes an HTML document. Signature is `pi --export <input.jsonl> [output.html]` (the second positional arg is the output path). Default output name is `pi-session-<basename>.html`.

**Don't use `--export` for machine verification.** Use the raw JSONL file.

### Raw session file layout

- Path: `<sessionDir>/<ISO-timestamp>_<uuid-v7>.jsonl`
  - Format from `session-manager.ts:741` area — filename is `new Date().toISOString().replace(/[:.]/g, "-") + "_" + sessionId + ".jsonl"`.
- Default `sessionDir`: `~/.pi/agent/sessions/--<cwd-slashes-to-dashes>--/` (`session-manager.ts:428-435`, `getDefaultSessionDir`).
- Override with `--session-dir <dir>` or env `PI_CODING_AGENT_DIR` (moves the whole agent dir; see `config.ts:194`).
- One-line-per-entry JSONL. First line is always the `SessionHeader`. All subsequent entries conform to `SessionEntry` (`session-manager.ts:138-150`). Tree structure via `id` / `parentId`.

### Minimal extract snippet (ordered roles + content types)

```bash
# Roles only
jq -r 'select(.type=="message") | .message.role' session.jsonl

# Roles + per-turn content kinds (text, toolCall, toolResult, ...)
jq -r 'select(.type=="message")
       | [.message.role,
          (.message.content|map(.type)|join(","))]
       | @tsv' session.jsonl

# Tool calls by name
jq -r 'select(.type=="message" and .message.role=="assistant")
       | .message.content[] | select(.type=="toolCall") | .name' session.jsonl
```

Node one-liner if `jq` unavailable:

```bash
node -e '
  const fs=require("fs");
  for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) {
    const e=JSON.parse(l);
    if (e.type==="message") console.log(e.message.role, e.message.content.map(c=>c.type).join(","));
  }' session.jsonl
```

Tool-call content item shape in assistant messages: `{"type":"toolCall","id":"...","name":"read","arguments":{...}}`. Tool-result content in subsequent user/tool messages: look for `{"type":"toolResult","toolCallId":"...","content":[...]}`. (See fixtures under `packages/coding-agent/test/fixtures/*.jsonl` for ground-truth examples.)

### Writes are synchronous

`session-manager.ts:801-819` uses `appendFileSync`. Once `pi -p` exits, the JSONL is fully flushed. **But**: entries up to the first assistant message are buffered in-memory and only written on assistant arrival (`_persist`, line 804-809). So a crash before the first assistant response yields an empty file. Not an issue for happy-path E2E.

---

## 4. Loading a local extension from source

### `--extension <path>` / `-e`

`core/extensions/loader.ts:481-511` (`resolveExtensionEntries`) + `:560-606` (`discoverAndLoadExtensions`):

- **File path (`.ts` / `.js`)** → loaded as a single extension. Must `export default function(pi: ExtensionAPI)`.
- **Directory** →
  1. `package.json` with `"pi": { "extensions": [...] }` → each listed path is loaded (good for multi-entry packages like workspace packages).
  2. Fallback: `index.ts` or `index.js` in the dir → loaded.
- `-e` can be passed multiple times.

### Loading a workspace package by path (no publish)

Point `-e` at the package's directory. Add a `pi.extensions` manifest to the package's `package.json`:

```json
// packages/context-bonsai/package.json
{
  "name": "@mariozechner/pi-context-bonsai",
  "pi": { "extensions": ["./src/index.ts"] }
}
```

Then: `./pi-test.sh -p --mode json -e packages/context-bonsai "prompt"`.

Alternatively, if the package ships a default-exported factory from its root, you can point `-e` at the entry file directly: `-e packages/context-bonsai/src/index.ts`. Jiti handles TS transparently (`loader.ts:341-353`). Workspace dependencies resolve via the monorepo's `node_modules` (it'll work from the repo root, which is `cwd` when `pi-test.sh` runs).

### Confirming load success without inspecting behaviour

- **Failures go to stderr loudly**: `Error: Failed to load extension "<path>": ...` (`main.ts` error reporting). Probed by deleting `ajv` from a stale monorepo — every load failure dumped a full stack trace to stderr before the session even started.
- **No positive "extension loaded" log by default**. The `json` / `rpc` event stream does not emit an extension-registered event.
- **Indirect positive signal via RPC**: `{"id":"1","type":"get_commands"}` returns any slash-commands the extension registered, including `source: "extension"` and `sourceInfo`. That's the cleanest "did my extension wire up?" check.
- **Indirect positive signal via JSON mode**: if your extension registers a tool, it appears in the first `agent_start`/`turn_start` snapshot's tool list (and a subsequent `toolCall` in the assistant message names it).

---

## 5. Verifying externally that a handler/tool fired

### Debug log

- `config.ts:261` defines `getDebugLogPath()` → `~/.pi/agent/pi-debug.log`.
- **Only written by the interactive `/debug` slash command** (`modes/interactive/interactive-mode.ts:5181-5204`). Not useful for `-p` E2E.
- No `DEBUG`, `PI_DEBUG`, `PI_LOG`, or `LOG_LEVEL` env var is honoured. (`grep -rn "process\.env\." packages/coding-agent/src/` lists every env touched — none are debug-level.)
- `PI_TIMING=1` enables startup timing to stderr (`core/timings.ts:6`), but that's performance instrumentation, not tool-trace.

### Session file records tool-call detail

Yes. Every `toolCall` and `toolResult` is persisted in the JSONL message entries. Grep-friendly:

```bash
jq -r 'select(.type=="message" and .message.role=="assistant")
       | .message.content[] | select(.type=="toolCall")
       | {name, args: .arguments}' session.jsonl
```

### RPC / JSON mode streams tool events to stdout

In `--mode json` (and rpc), `session.subscribe(event => writeRawStdout(JSON.stringify(event)+"\n"))` emits the full `AgentSessionEvent` stream, including `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` (see `packages/agent-core/src/...` — grep `tool_execution_start`). These are machine-parseable on stdout.

**This is the highest-fidelity signal**: you can assert "tool X fired with args Y" by consuming stdout line-by-line.

---

## 6. Minimum reproducible two-turn script

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/basil/projects/context-bonsai-pi
DIR=$(mktemp -d -t pi-e2e-XXXX)
trap 'rm -rf "$DIR"' EXIT

cd "$ROOT"

# Turn 1: fresh session, capture json event stream to a log.
./pi-test.sh -p --mode json \
    --no-extensions \
    --session-dir "$DIR" \
    "say hello in one word" > "$DIR/turn1.jsonl"

SESSION_FILE=$(ls "$DIR"/*.jsonl | grep -v turn1 | head -1)

# Turn 2: continue the exact same session file.
./pi-test.sh -p --mode json \
    --no-extensions \
    --session-dir "$DIR" \
    --session "$SESSION_FILE" \
    "and now in spanish" > "$DIR/turn2.jsonl"

# Assertions on the session file (the authoritative state store).
USER=$(grep -c '"role":"user"' "$SESSION_FILE")
ASSIST=$(grep -c '"role":"assistant"' "$SESSION_FILE")
[[ "$USER"   == "2" ]] || { echo "expected 2 user messages, got $USER"; exit 1; }
[[ "$ASSIST" == "2" ]] || { echo "expected 2 assistant messages, got $ASSIST"; exit 1; }

# Optional: assert on event stream shape.
grep -q '"type":"agent_end"' "$DIR/turn1.jsonl"
grep -q '"type":"agent_end"' "$DIR/turn2.jsonl"

echo "OK"
```

Run verified manually (step-by-step): two `.jsonl` writes, final session file had 7 lines after 2 turns (header + model_change + thinking_level_change + 4 messages = 7). A third turn via `-c` grew it to 9 lines as expected.

---

## 7. Failure modes & flakiness to document

### Sync write / race concerns

- **Synchronous writes**: `appendFileSync` — turn data is durable when `pi -p` exits cleanly. Safe for sequential scripting.
- **Early-turn buffering**: before the first assistant message, entries (header, model_change, thinking_level_change, user-message entry) live only in memory. A `SIGKILL` or crash before the LLM responds produces an empty file. The session subscribe handler in `-p` catches errors and writes them as assistant messages with `stopReason: "error"`, so this is mostly contained.
- **No file lock**: nothing prevents two concurrent `pi -p --session <same-file>` processes from interleaving writes. Treat session files as owned by exactly one invocation at a time.
- **`-c` race in shared session-dir**: `continueRecent` picks the mtime-newest file. If two turns run in parallel against the same `--session-dir`, they'll race on "which session to continue." Use `--session <path>` for anything concurrent, or per-test directories.

### Stdout vs stderr

- **Stdout**:
  - `-p` text: final assistant text only.
  - `-p --mode json`: one JSON event per line, starts with `SessionHeader`, ends with `agent_end`.
  - `--mode rpc`: JSON responses + events, protocol on stdin/stdout.
- **Stderr**:
  - Extension load errors (`Error: Failed to load extension "<path>": ...`).
  - Migration / diagnostic warnings.
  - `console.error` from `runPrintMode` on assistant `stopReason === "error"` or `"aborted"` (then exit 1).
  - chalk-coloured — pipe through `sed -r "s/\x1b\[[0-9;]*m//g"` or set `NO_COLOR=1` in CI.
- Model outputs never mix into stderr in `-p` modes.

### Env quirks

- `./pi-test.sh --no-env` does **not** clear `~/.pi/agent/auth.json` OAuth tokens. If you need a truly offline run, move `auth.json` aside and set `PI_OFFLINE=1`.
- `PI_CODING_AGENT_DIR` overrides the whole `~/.pi/agent` root — useful for hermetic test homes (set it to a temp dir and pi won't touch your real config).
- `PI_OFFLINE=1` (or `--offline`) disables startup network operations (update check, telemetry). Good for CI.

### Things that currently have no CLI affordance

1. **"Extension X successfully loaded" event**: no positive signal in the event stream. Work around via `get_commands` (RPC) or `get_state` / tool-catalog inspection.
2. **A debug log for `-p` runs**: `pi-debug.log` is interactive-only. Tests must rely on the JSON event stream and the session JSONL.
3. **Skipping the model call entirely**: no dry-run flag. RPC mode lets you send non-prompt commands, but any `prompt` triggers a real model call.
4. **Export to JSONL**: `--export` is HTML-only. Just copy the session file from `sessionDir` if you want the raw stream.

---

## Appendix: surprise relative to OpenCode

- **Better than OpenCode**: `-p --mode json` gives a first-class, documented, deterministic event stream on stdout — no scraping, no separate `opencode export` step. Session JSONL is stable, versioned (v3), migration-aware, and directly readable. This is a genuinely nicer e2e target than OpenCode's `opencode run --continue` + `opencode export`.
- **Worse than OpenCode**: no single-file combined "session + transcript" export; `--export` is HTML-only (cosmetic), not structured data. The protocol therefore has to read the raw `.jsonl` for any assertion beyond "did it finish."
- **Gaps**: no verbose/debug log in `-p`; no positive extension-loaded signal; no dry-run mode.
