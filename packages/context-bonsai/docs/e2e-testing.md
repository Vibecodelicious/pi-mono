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
- API credentials discoverable through Pi's `AuthStorage.hasAuth(provider)`. Any of the following is sufficient:
  - `pi login <provider>` has been run for the configured provider (writes `~/.pi/agent/auth.json`, mode 600).
  - A hand-edited `api_key` entry for the configured provider in `~/.pi/agent/auth.json` (or under `$PI_CODING_AGENT_DIR/auth.json` if that override is set).
  - A provider-specific env var that Pi recognises (`ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, AWS Bedrock credentials, GCP Vertex ADC, GitHub Copilot tokens, etc. — see `packages/ai/src/env-api-keys.ts` for the full surface).
  - The harness-specific override `BONSAI_E2E_API_KEY=<key>` for the configured provider (applied via `setRuntimeApiKey()` before the gate check; highest priority per `auth-storage.ts:415-422`).
- Optional pinning:
  - `BONSAI_E2E_PROVIDER` (default: `anthropic`)
  - `BONSAI_E2E_MODEL` (default: `claude-sonnet-4-6`)

The harness gates scenario execution by shelling out to `test/e2e/check-credentials.ts` (a `tsx`-runnable shim that imports `AuthStorage` from `@mariozechner/pi-coding-agent`). On success the shim is silent and exits 0. On failure it exits 3 with a deterministic stderr message naming (i) the auth-store path including the `$PI_CODING_AGENT_DIR` override hint, (ii) the harness override `BONSAI_E2E_API_KEY`, and (iii) the operator-actionable next step (`pi login <provider>` or set `BONSAI_E2E_API_KEY`). The harness does NOT invoke `pi login` automatically.

---

## Pre-flight Checks

1. From `pi/packages/context-bonsai/`, run `npm test` to confirm unit + integration tests are green against the current commit (the suite includes `test/e2e-credentials.test.ts`, the deterministic credential-discovery unit tests).
2. From `pi/`, run `npm run check` to confirm biome / tsgo / browser-smoke pass.
3. Credential check (manual): `cd pi && node_modules/.bin/tsx packages/context-bonsai/test/e2e/check-credentials.ts` should exit 0. If it exits 3, the stderr message names the auth-store path, the `BONSAI_E2E_API_KEY` override, and the next step (`pi login <provider>` or set `BONSAI_E2E_API_KEY`).
4. Smoke: `bash test/e2e/run-e2e.sh --scenario A` — should complete in well under 30 s and report `A: PASS`. If A fails on a fresh clone, do not move on; the extension probably isn't loading.

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

**Pi observability constraint (important):** Pi's `--mode json` event stream emits `message_end` for the *original* user message in `agent-loop.ts:113` — BEFORE the `context` event transform runs. The gauge text injected by `maybeInjectGauge` is therefore never present in the captured stdout, and the session JSONL likewise stores the raw pre-transform user message. The post-transform payload sent to the LLM is observable only via the `before_provider_request` extension hook, which has no stdout emission in print mode. Direct stdout-grep for `[CONTEXT GAUGE:` is therefore not a valid assertion strategy in the current Pi surface.

**What the harness asserts instead (cadence prerequisites):**
- All 10 turns emit `agent_end` (no extension load failure or provider error).
- No turn's stderr contains `Failed to load extension`.
- The session JSONL contains 10 user messages (the cadence input).

The cadence-arithmetic invariant — that `state.turnCount` is hydrated from session user messages on `session_start`, so 10 user messages drive 2 gauge fires (turns 5 and 10) — is pinned by the regression test `test/prompt.test.ts > "session_start hydrates turnCount from prior user messages so gauge cadence survives a process restart"`. Without that hydration, scenario E would silently never fire the gauge under Pi's `-p` mode (each invocation is a fresh process; in-memory `state.turnCount` would always be 1).

**Failure patterns:**
- < 10 `agent_end` events — a turn crashed mid-flight. Read the per-turn `*.err`.
- `Failed to load extension` in any err file — extension wiring broke between turns; check workspace symlinks.
- < 10 user messages in session JSONL — `--session` resume isn't actually pinning to the same file; verify `pi_session_file` returned a valid path after turn 1.

**Direct gauge-text observability** would require either (a) emitting a `before_provider_request` mirror event in `--mode json`, (b) extending `maybeInjectGauge` to write a `context-bonsai:gauge` custom session entry on each fire, or (c) using `--mode rpc` with a custom command that reads the post-transform payload. None of these is in scope for Story P.5; the test pivot keeps the cadence-firing contract pinned via the in-process regression test.

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
- 0 occurrences of `[PRUNED: ` in the turn 3 stream. **Caveat:** this is trivially true under the Pi observability constraint described in scenario E — the post-transform payload (where the placeholder, if any, would appear) never lands in stdout. The deterministic assertion is the persisted archive-clear tombstone in the session JSONL, which directly proves the retrieve fired and tombstone-wins precedence holds at the persistence layer. Deep transcript correctness is covered by Story P.2's `02b-prune-with-compaction.test.ts`.

**Failure patterns:**
- Retrieve returns `Error: No archive found ...` even though prune logged `Archived ...` — the model's anchor extraction failed; rerun. If persistent, the prune success-string format may have drifted (the model parses it textually).
- `sessionHasCustomEntry(file, "context-bonsai:archive-clear").length === 0` — `pi.appendEntry` didn't fire from `retrieve.ts`; check the capability gate.

**Matcher mapping:** `eventStreamToolResult` for both tools, `sessionHasCustomEntry` for both customTypes.

---

### Scenario G — Secret prune oracle

**Goal:** prune surgically removes sensitive content from active context. After the prune, the model cannot recall the secret from currently visible context (it can only see the placeholder summary, which omits the nonce).

**Setup:** fresh tmpdir. Generate a high-entropy nonce (e.g. `OPENSESAME$$$(date +%s)`). Turn 1 instructs the model to remember the nonce. Turn 2 is filler so the secret is not the most recent message. Turn 3 instructs `context-bonsai-prune` over the nonce-bearing range, with a summary and index terms that **explicitly do not include** the nonce string. Turn 4 asks the model to recall the exact secret.

**Expected JSON-stream markers (turn 4):**
- 0 occurrences of the literal nonce in the captured event stream — neither in the post-transform user message nor in the assistant's final answer. The placeholder is visible to the model but does not carry the nonce. This is the actual behavioural oracle (the model has no path to recall the nonce after the prune).

**Expected session-JSONL markers (after turn 3):**
- ≥ 1 `context-bonsai:archive` custom entry — proves the prune persisted.

Note: a `[PRUNED: ` placeholder-sanity assertion against the captured stdout is NOT used here, for the same Pi observability reason described in scenario E (the post-transform payload doesn't appear in `--mode json` stdout). The persisted archive entry is the deterministic side-effect we assert on.

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
| 2026-05-07 | 717d81de (parent of this row's commit) | openai-codex / gpt-5.3-codex | PASS | PASS | PASS | PASS | PASS | PASS | PASS | First green run after the iter-2 amendment (credential-discovery shim delegating to `AuthStorage.hasAuth`). Prompts adjusted to use unique NORTHSTAR-prefixed anchor labels in the seed turn, with the user prompt instructing the model to copy them verbatim from the first user message — this avoids prune-pattern ambiguity from echoed pattern strings. Scenario E pivoted to assert cadence prerequisites (10 user messages, 10 clean agent_end events, no extension load failures) plus a session_start hydration regression test in `prompt.test.ts`; direct stdout-grep for `[CONTEXT GAUGE:` is not feasible under Pi's `--mode json` (events emit pre-transform). Scenario G dropped its placeholder-sanity stdout-grep for the same reason; the no-leak behavioural oracle and the persisted archive entry are the deterministic checks. Path bug fixed in `run-e2e.sh` (`PACKAGE_DIR` was one level too shallow). Full run wall-time ≈ 3 min. |
