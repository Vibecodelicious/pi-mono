# context-bonsai E2E Testing Protocol

This document is the manual / pre-release release-gate for the `@mariozechner/pi-context-bonsai` extension. The Pi-interaction primitives it relies on (driver flags, session-file layout, `--mode json` event stream shape, multi-turn pinning) are documented in `.agents/research/pi-e2e-interaction-baseline.md` — read that first. This document focuses solely on what is bonsai-specific: the seven scenarios, their setup prompts, the JSON-stream and session-JSONL markers each scenario asserts on, and the failure patterns to watch for.

The suite is **not** wired into `npm run check` (each scenario costs a real LLM call). It is invoked manually via `bash test/e2e/run-e2e.sh --all` (or `npm run e2e` from this package's directory) when an operator with credentials wants to certify a build.

---

## Purpose

Unit + integration tests in Stories P.1–P.4 prove module-level correctness against a faux provider. This protocol proves the full stack works when driven through the real `pi` CLI against a real LLM:

- the extension loads, both tools register
- prune / retrieve fire end-to-end and persist their custom session entries
- the archive state survives a process restart (reload path)
- the gauge appears on cadence and reaches the model in-band
- the same-turn prune+retrieve no-op (Pi's intentional simplification) holds end-to-end
- pruned secret content does not survive into post-prune model-visible context

Deep transform correctness is **not** the goal here — that is covered by the integration suite (notably `02b-prune-with-compaction.test.ts`).

---

## Prerequisites

- The pi monorepo is checked out and `npm install` has run from the repo root (so `node_modules/.bin/tsx` exists for `pi-test.sh`).
- The bonsai package's `package.json` declares `"pi": { "extensions": ["./src/index.ts"] }` (verified in this repo).
- `bash`, Node ≥ 20, and a working `pi-test.sh` at the repo root.
- API credentials reachable to the shell:
  - `BONSAI_E2E_API_KEY=<key>` (generic, mirrored into the provider's expected env at runtime by the operator), OR
  - `ANTHROPIC_API_KEY=<key>` for the default provider.
- Optional pinning:
  - `BONSAI_E2E_PROVIDER` (default: `anthropic`)
  - `BONSAI_E2E_MODEL` (default: `claude-sonnet-4-6`)

The harness fails fast with exit code 3 if neither env var is set; it does not silently skip.

---

## Pre-flight Checks

1. From `pi/packages/context-bonsai/`, run `npm test` to confirm unit + integration tests are green against the current commit.
2. From `pi/`, run `npm run check` to confirm biome / tsgo / browser-smoke pass.
3. Smoke: `bash test/e2e/run-e2e.sh --scenario A` — should complete in well under 30 s and report `A: PASS`. If A fails on a fresh clone, do not move on; the extension probably isn't loading.

---

## Driver Pattern (recap of `.agents/research/pi-e2e-interaction-baseline.md`)

Every Pi invocation in this protocol uses:

```
./pi-test.sh -p --mode json \
    --provider $BONSAI_E2E_PROVIDER \
    --model $BONSAI_E2E_MODEL \
    -e packages/context-bonsai \
    --session-dir <fresh-tmpdir> \
    [--session <pinned-session-jsonl>] \
    "<prompt>"
```

`--mode json` streams every `AgentSessionEvent` as one JSON object per line on stdout (see `packages/coding-agent/src/modes/print-mode.ts`); we capture that to a per-turn log file and assert on it via `test/e2e/assert.mjs`. The session JSONL Pi writes under `--session-dir` is the second authoritative source; we read it with the same matchers (`sessionHasCustomEntry`, `sessionHasMessageMatching`).

---

## Scenarios

### Scenario A — Extension loads + tool registered

**Goal:** the extension wires up cleanly; both tools are visible to the model on the first turn.

**Setup:** fresh tmpdir; one prompt: `"list the tools available to you"`.

**Expected JSON-stream markers:**
- a `tool_execution_*` event or assistant `message_end.content[].toolCall` referencing `context-bonsai-prune`.
- same for `context-bonsai-retrieve`.
- at least one `agent_end` event (clean exit).

**Expected session-JSONL markers:** none required for this scenario.

**Failure patterns:**
- `Failed to load extension` line in stderr (extension wiring broken — check workspace symlinks and `pi.extensions` manifest).
- No `agent_end` (Pi crashed mid-turn — read the captured `*.err`).
- Tool not registered in the event stream (factory threw at register time, e.g. missing capability).

**Matcher mapping:** `eventStreamContainsTool(log, "context-bonsai-prune")`, `...("context-bonsai-retrieve")`, `countMatchesInEventStream(log, /"type":"agent_end"/)`.

---

### Scenario B — Prune archives a contiguous range

**Goal:** the model can fire `context-bonsai-prune` and the call persists an `ArchiveRecord` to the session file with the canonical fields populated.

**Setup:**
- Turn 1 prompt: a content-bearing message that establishes pattern boundaries the model will recognise. The harness uses three completed reference facts (`alpha=red`, `beta=green`, `gamma=blue`).
- Turn 2 prompt: explicit instruction `"Call context-bonsai-prune now. Use from_pattern \"alpha=red\" and to_pattern \"gamma=blue\", summary \"...\", and index_terms [...]."`. We instruct the model so the boundaries are deterministic; we still assert on structural markers, not on prose.

**Expected JSON-stream markers (turn 2):**
- `tool_execution_end` for `context-bonsai-prune` with `isError === false`.
- result `content[0].text` starts with `Archived ` (Story P.2 success-string prefix from `prune.ts` ~line 274).

**Expected session-JSONL markers (after turn 2):**
- exactly one `customType: "context-bonsai:archive"` entry.
- that entry's `data` has non-empty `anchorEntryId`, `rangeEndEntryId`, `summary`, and a non-empty `indexTerms` array.

**Failure patterns:**
- `tool_execution_end.isError === true` with content like `Validation error: ...` — the model picked a non-resolving pattern; rerun. If recurring, sharpen the prompt.
- `Pattern \"X\" matched N messages (ambiguous)` — the prompt's tokens matched the model's own echoed text. Pick patterns that appear only inside the seed message.
- 0 archive entries written but `tool_execution_end.isError === false` — would be a bug in `pi.appendEntry` or schema serialisation; preserve the tmpdir and triage.

**Matcher mapping:** `eventStreamToolResult(log, "context-bonsai-prune")`, `sessionHasCustomEntry(sessionFile, "context-bonsai:archive")`.

---

### Scenario C — Retrieve restores

**Goal:** retrieve clears the archive and writes the tombstone tombstone.

**Setup:** continues the session from B (the harness reuses B's tmpdir + session file via a state breadcrumb; if C is invoked standalone, it transparently re-runs B as setup). Turn 3 prompt: `"Call context-bonsai-retrieve with anchor_id <anchor> right now."`.

**Expected JSON-stream markers (turn 3):**
- `tool_execution_end` for `context-bonsai-retrieve` with `isError === false`.
- result `content[0].text` starts with `Restored ` (Story P.3 success-string prefix from `retrieve.ts`).

**Expected session-JSONL markers (after turn 3):**
- exactly one `customType: "context-bonsai:archive-clear"` entry (the tombstone).

**Failure patterns:**
- `Error: No archive found for message <anchor>` — the model passed the wrong anchor id. The harness extracts the anchor from B's archive entry programmatically; if this fires it indicates a regression in archive ID stability.
- 0 tombstone entries — `pi.appendEntry` didn't fire; check `retrieve.ts` capability gate.

**Matcher mapping:** `eventStreamToolResult(log, "context-bonsai-retrieve")`, `sessionHasCustomEntry(sessionFile, "context-bonsai:archive-clear")`.

---

### Scenario D — Reload persistence

**Goal:** archive state survives a fresh `pi` process. The new process must start without throwing on `session_start` hydration and the archive entry must remain.

**Setup:** independent tmpdir. Reproduce B (turn 1 + turn 2). Then start a **new** `pi` process pinned to the same `--session <file>` with prompt `"noop"`.

**Expected JSON-stream markers (reload turn):**
- `agent_end` event present (means `session_start` hydration completed without throwing — a regression in `ArchiveStore.hydrateFromEntries` would error out before this).

**Expected session-JSONL markers:**
- still exactly one `context-bonsai:archive` entry; zero `context-bonsai:archive-clear`.

**Failure patterns:**
- New process crashes during startup (no `agent_end`) — the most likely cause is a schema drift between Story P.1 (write side) and Story P.2's hydrator (read side). Diagnose by running `node -e 'const e = require("...assert.mjs").sessionHasCustomEntry(...);'` against the session file.
- Tombstone unexpectedly appears — something else wrote an `archive-clear` between B's prune and the reload (very unlikely).

**Matcher mapping:** `countMatchesInEventStream(log, /"type":"agent_end"/)`, `sessionHasCustomEntry(sessionFile, "context-bonsai:archive")`, `sessionHasCustomEntry(sessionFile, "context-bonsai:archive-clear")`.

---

### Scenario E — Gauge cadence

**Goal:** the gauge fires on cadence (every 5 turns by default per `gauge.ts:GAUGE_CADENCE = 5`) and reaches the model in-band.

**Setup:** fresh tmpdir, empty session, then run 10 turns in sequence with trivial prompts (`"turn 1"`, `"turn 2"`, ..., `"turn 10"`). After all turns, concatenate the per-turn JSONL logs into one stream.

**Expected JSON-stream markers (concatenated):**
- at least 2 lines containing the gauge-marker substring `[CONTEXT GAUGE:` (turn indices 5 and 10).
- at least one of those occurrences appears on a line whose JSON contains `"role":"user"` — i.e. inside the post-transform user message that the model received. This is the "in-band" check; the gauge is appended to the last user message during the `context` event (`gauge.ts:maybeInjectGauge`).

**Failure patterns:**
- 0 markers — `ctx.getContextUsage()` returned null tokens for the entire session, OR the cadence counter never reached 5. The first is provider-specific (some providers don't emit token usage on the first message); rerun against `claude-sonnet-4-6` to baseline.
- > 2 markers — turn counter advancing more than once per turn; bug.
- 2 markers, but none on a `"role":"user"` line — the gauge was attached but to a non-user message, indicating a regression in `maybeInjectGauge`'s `lastUserIdx` lookup.

**Matcher mapping:** `countMatchesInEventStream(concat, /\[CONTEXT GAUGE:/)`, then a refined regex that requires `"role":"user"` and the gauge marker on the same line.

---

### Scenario F — Same-turn prune+retrieve is a supported no-op

**Goal:** Pi's intentional same-turn no-op behaviour holds end-to-end. Both tool calls succeed, both custom entries persist (audit record), and the next turn's transcript is un-elided.

**Setup:** fresh tmpdir. Turn 1 seeds the same three-fact reference. Turn 2 prompt: a single message instructing the model to call `context-bonsai-prune` and then `context-bonsai-retrieve` (with the resulting anchor) **in the same response**. Turn 3 is a trivial follow-up (`"what color is alpha? answer in one word."`); we assert no `[PRUNED: ` marker appears in turn 3's transcript.

**Expected JSON-stream markers (turn 2):**
- `tool_execution_end` for `context-bonsai-prune` with `isError === false`, content prefix `Archived `.
- `tool_execution_end` for `context-bonsai-retrieve` with `isError === false`, content prefix `Restored `.

**Expected session-JSONL markers (after turn 2):**
- ≥ 1 `context-bonsai:archive` AND ≥ 1 `context-bonsai:archive-clear`. Both audit records persist (the spec calls this "audit clean").

**Expected JSON-stream markers (turn 3):**
- 0 occurrences of `[PRUNED: ` in the turn 3 stream — the tombstone supersedes the archive at hydrate time, so the placeholder must not render.

**Failure patterns:**
- Turn 3 contains a `[PRUNED: ` marker — the tombstone-wins precedence in `archive-store.ts:hydrateFromEntries` regressed, OR the in-memory store wasn't updated by `retrieve.ts`. Either is a P.2/P.3 regression.
- Retrieve returns `Error: No archive found ...` even though prune logged `Archived ...` — the model's anchor extraction failed; rerun. If persistent, the prune success-string format may have drifted (the model parses it textually).

**Matcher mapping:** `eventStreamToolResult` for both tools, `sessionHasCustomEntry` for both customTypes, `countMatchesInEventStream(log3, /\[PRUNED: /)`.

---

### Scenario G — Secret prune oracle

**Goal:** prune surgically removes sensitive content from active context. After the prune, the model cannot recall the secret from currently visible context (it can only see the placeholder summary, which omits the nonce).

**Setup:** fresh tmpdir. Generate a high-entropy nonce (e.g. `OPENSESAME$$$(date +%s)`). Turn 1 instructs the model to remember the nonce. Turn 2 is filler so the secret is not the most recent message. Turn 3 instructs `context-bonsai-prune` over the nonce-bearing range, with a summary and index terms that **explicitly do not include** the nonce string. Turn 4 asks the model to recall the exact secret.

**Expected JSON-stream markers (turn 4):**
- 0 occurrences of the literal nonce in the captured event stream — neither in the post-transform user message nor in the assistant's final answer. The placeholder is visible to the model but does not carry the nonce.
- ≥ 1 occurrence of `[PRUNED: ` (sanity: the placeholder is rendering).

**Failure patterns:**
- Nonce present in turn 4 stream — the prune didn't elide the right range, OR the placeholder leaked some echo of the nonce, OR the model copy-pasted the nonce into its assistant reply (which would mean it still had access). Triage via the session file: confirm an archive entry was written, that the anchor/range-end span the nonce-bearing message, and that the placeholder text in the post-transform stream does not contain the nonce.
- No placeholder marker — prune call failed or context-transform skipped the archive (anchor not findable in `event.messages`).

This is a behavioural oracle, not proof of secrecy against logs — the session JSONL still contains the original message; the protocol asserts only that the **active model-visible context** no longer carries the nonce.

**Matcher mapping:** `countMatchesInEventStream(log4, /<nonce>/)`, `countMatchesInEventStream(log4, /\[PRUNED: /)`.

---

## Recording Results

After every full `run-e2e.sh --all` run, append a row to the Test Runs table below.

Required fields:
- date (ISO)
- pi commit hash
- provider/model used
- per-scenario verdict
- short observation list (anything noteworthy: prompt drift that needed retry, model picking weird patterns, gauge cadence variance, etc.)

### Test Runs

| Date | Commit | Provider/Model | A | B | C | D | E | F | G | Observations |
|------|--------|----------------|---|---|---|---|---|---|---|--------------|
| (pending) | (pending) | (pending) | — | — | — | — | — | — | — | Live run pending operator credentials. The harness, matchers (with 14 unit tests), fixtures, and `e2e` package script are in place at `b477e5c8`'s descendant; the orchestrator's developer subagent did not have `ANTHROPIC_API_KEY` / `BONSAI_E2E_API_KEY` accessible. To complete: export an Anthropic key (or set `BONSAI_E2E_API_KEY` plus the appropriate provider env), then run `cd packages/context-bonsai && npm run e2e`, append the resulting verdicts here, and commit. |
