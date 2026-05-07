#!/usr/bin/env bash
#
# context-bonsai e2e harness.
#
# Drives `./pi-test.sh` non-interactively against a real LLM, captures the
# `--mode json` event stream per turn, and asserts via Node helpers in
# `assert.mjs`. Intended as a manual / pre-release gate; NOT wired into
# `npm run check`.
#
# Usage:
#   bash test/e2e/run-e2e.sh --scenario A
#   bash test/e2e/run-e2e.sh --all
#
# Credential discovery:
#   The harness delegates to Pi's `AuthStorage.hasAuth(provider)` via the shim
#   at `test/e2e/check-credentials.ts`. The shim accepts ANY credential source
#   Pi recognises: `pi login <provider>`-installed entries in `auth.json`,
#   hand-edited api_key entries, OAuth-token env vars (ANTHROPIC_OAUTH_TOKEN
#   etc., see packages/ai/src/env-api-keys.ts), models.json fallback, and the
#   harness override BONSAI_E2E_API_KEY (applied via setRuntimeApiKey).
#
# Optional env:
#   BONSAI_E2E_API_KEY=<key>          # harness-only runtime override (any provider)
#   BONSAI_E2E_PROVIDER (default: anthropic)
#   BONSAI_E2E_MODEL    (default: claude-sonnet-4-6)
#
# Exits 0 on PASS; non-zero otherwise. With `--all`, the worst-case exit code
# is reported and a per-scenario summary is printed.
#
# Per scenario:
#   - mktemp -d a fresh session-dir
#   - run the prompt sequence with `--mode json`, capturing stdout per turn
#   - call into Node + assert.mjs to verify markers
#   - print `<SCENARIO>: PASS` or `<SCENARIO>: FAIL <reason>`
#   - cleanup the tmpdir on success; preserve on failure for triage

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
PI_TEST="$PI_ROOT/pi-test.sh"
ASSERT_MJS="$SCRIPT_DIR/assert.mjs"

: "${BONSAI_E2E_PROVIDER:=anthropic}"
: "${BONSAI_E2E_MODEL:=claude-sonnet-4-6}"

# ---- argv ----
SCENARIO=""
RUN_ALL=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--scenario)
			SCENARIO="$2"
			shift 2
			;;
		--all)
			RUN_ALL=1
			shift
			;;
		-h|--help)
			grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "run-e2e: unknown arg '$1'" >&2
			exit 2
			;;
	esac
done

if [[ -z "$SCENARIO" && "$RUN_ALL" -eq 0 ]]; then
	echo "run-e2e: pass --scenario <A..G> or --all" >&2
	exit 2
fi

if [[ ! -x "$PI_TEST" ]]; then
	echo "run-e2e: pi-test.sh not found or not executable at $PI_TEST" >&2
	exit 4
fi

# ---- credential gate ----
# Delegate to the credential-discovery shim, which calls Pi's
# AuthStorage.hasAuth(provider). The shim handles BONSAI_E2E_API_KEY -> runtime
# override translation and emits its own deterministic stderr error on miss.
# Do not double-wrap or rephrase its message; let it surface verbatim.
TSX_BIN="$PI_ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
	echo "run-e2e: tsx not found at $TSX_BIN — run npm install from pi/ first" >&2
	exit 4
fi
(cd "$PI_ROOT" && "$TSX_BIN" packages/context-bonsai/test/e2e/check-credentials.ts)
gate_rc=$?
if [[ $gate_rc -ne 0 ]]; then
	exit "$gate_rc"
fi

# ---- driver helpers ----
# All scenarios share a fresh session-dir per turn. Pi writes the session JSONL
# under that dir as `<ISO>_<uuid>.jsonl`.

# Run a single Pi turn with `--mode json`, capturing stdout to $log_path and
# stderr to ${log_path%.jsonl}.err. Returns Pi's exit code. Auto-honors the
# pinned provider/model via -p flags.
pi_turn() {
	local session_dir="$1"; shift
	local session_file="$1"; shift
	local log_path="$1"; shift
	local prompt="$1"; shift

	local err_path="${log_path%.jsonl}.err"
	local cmd=(
		"$PI_TEST" -p --mode json
		--provider "$BONSAI_E2E_PROVIDER"
		--model "$BONSAI_E2E_MODEL"
		-e packages/context-bonsai
		--session-dir "$session_dir"
	)
	if [[ -n "$session_file" ]]; then
		cmd+=( --session "$session_file" )
	fi
	cmd+=( "$prompt" )

	(cd "$PI_ROOT" && "${cmd[@]}") > "$log_path" 2> "$err_path"
}

# Pick the freshest session JSONL in $session_dir (the Pi-written one, not
# our captured event-stream logs).
pi_session_file() {
	local session_dir="$1"
	# Pi writes <ISO>_<uuid>.jsonl in the session-dir. Our captured event-stream
	# logs go to a sibling `logs/` subdir, so a flat ls of *.jsonl in
	# session-dir is unambiguous.
	ls -1t "$session_dir"/*.jsonl 2>/dev/null | head -1
}

# Run a tiny Node program against assert.mjs and the captured artifacts. Echoes
# `OK` on success and `FAIL <reason>` on failure. Each `assert_*` call is one
# Node process — keeps things simple and lets bash control sequencing.
node_assert() {
	local script="$1"
	node --input-type=module -e "$script"
}

# Emit a per-scenario verdict line. Honors $TMPDIR cleanup policy: on PASS we
# rm the per-scenario tmpdir; on FAIL we preserve it and print the path.
emit_verdict() {
	local name="$1"
	local status="$2"
	local reason="$3"
	local tmpdir="$4"
	if [[ "$status" == "PASS" ]]; then
		rm -rf "$tmpdir"
		echo "$name: PASS"
		return 0
	fi
	echo "$name: FAIL $reason"
	echo "  preserved: $tmpdir"
	return 1
}

# ---- scenario implementations ----

scenario_A() {
	local name="A"
	local tmpdir
	tmpdir=$(mktemp -d -t pi-bonsai-A-XXXX)
	mkdir -p "$tmpdir/logs"
	local log="$tmpdir/logs/turn1.jsonl"

	pi_turn "$tmpdir/sess" "" "$log" "list the tools available to you"
	local rc=$?
	if [[ $rc -ne 0 ]]; then
		emit_verdict "$name" FAIL "pi-test.sh exited $rc; see ${log%.jsonl}.err" "$tmpdir"
		return 1
	fi

	local err_path="${log%.jsonl}.err"
	if grep -q "Failed to load extension" "$err_path"; then
		emit_verdict "$name" FAIL "extension load error in stderr" "$tmpdir"
		return 1
	fi

	local result
	result=$(node_assert "
		import { eventStreamContainsTool, countMatchesInEventStream } from '$ASSERT_MJS';
		const log = '$log';
		const errors = [];
		if (!eventStreamContainsTool(log, 'context-bonsai-prune')) errors.push('prune tool not registered');
		if (!eventStreamContainsTool(log, 'context-bonsai-retrieve')) errors.push('retrieve tool not registered');
		if (countMatchesInEventStream(log, /\"type\":\"agent_end\"/) < 1) errors.push('no agent_end event');
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		emit_verdict "$name" PASS "" "$tmpdir"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

scenario_B() {
	local name="B"
	local tmpdir
	tmpdir=$(mktemp -d -t pi-bonsai-B-XXXX)
	mkdir -p "$tmpdir/logs"
	local sd="$tmpdir/sess"

	# Turn 1: seed history.
	pi_turn "$sd" "" "$tmpdir/logs/turn1.jsonl" \
		"Remember these three facts as completed reference material: alpha=red, beta=green, gamma=blue. Acknowledge briefly."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "turn1 nonzero exit" "$tmpdir"; return 1; }

	local sf
	sf=$(pi_session_file "$sd")
	[[ -z "$sf" ]] && { emit_verdict "$name" FAIL "no session file written" "$tmpdir"; return 1; }

	# Turn 2: instruct the model to call prune. We don't care which exact
	# patterns the model picks; any pattern that resolves to one boundary is
	# acceptable. The success-string prefix `Archived ` is what we assert on.
	pi_turn "$sd" "$sf" "$tmpdir/logs/turn2.jsonl" \
		"Call context-bonsai-prune now. Use from_pattern \"alpha=red\" and to_pattern \"gamma=blue\", summary \"completed reference facts\", and index_terms [\"alpha\",\"beta\",\"gamma\",\"colors\"]."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "turn2 nonzero exit" "$tmpdir"; return 1; }

	local result
	result=$(node_assert "
		import { eventStreamToolResult, sessionHasCustomEntry } from '$ASSERT_MJS';
		const log = '$tmpdir/logs/turn2.jsonl';
		const sess = '$sf';
		const errors = [];
		const r = eventStreamToolResult(log, 'context-bonsai-prune');
		if (!r) errors.push('no tool_execution_end for prune');
		else {
			if (r.isError) errors.push('prune returned isError=true: ' + JSON.stringify(r.content));
			else if (!r.content[0] || !r.content[0].text || !r.content[0].text.startsWith('Archived ')) {
				errors.push('prune content did not start with Archived: ' + JSON.stringify(r.content));
			}
		}
		const archives = sessionHasCustomEntry(sess, 'context-bonsai:archive');
		if (archives.length !== 1) errors.push('expected 1 archive entry, got ' + archives.length);
		else {
			const d = archives[0].data || {};
			for (const k of ['anchorEntryId','rangeEndEntryId','summary','indexTerms']) {
				if (!d[k] || (Array.isArray(d[k]) && d[k].length === 0) || (typeof d[k] === 'string' && d[k].trim() === '')) {
					errors.push('archive.data.' + k + ' empty');
				}
			}
		}
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		# Save the anchor for Scenario C reuse via a state file.
		node_assert "
			import { sessionHasCustomEntry } from '$ASSERT_MJS';
			const e = sessionHasCustomEntry('$sf', 'context-bonsai:archive');
			console.log(e[0].data.anchorEntryId);
		" > "$tmpdir/anchor.txt"
		# Don't auto-cleanup; Scenario C may want to reuse. The wrapper handles
		# cleanup at the end of --all.
		echo "$tmpdir" > "$PACKAGE_DIR/.last_B_tmpdir"
		echo "$sf" > "$PACKAGE_DIR/.last_B_sessionfile"
		echo "$name: PASS"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

scenario_C() {
	local name="C"
	local tmpdir sf anchor
	if [[ -f "$PACKAGE_DIR/.last_B_tmpdir" && -f "$PACKAGE_DIR/.last_B_sessionfile" ]]; then
		tmpdir=$(cat "$PACKAGE_DIR/.last_B_tmpdir")
		sf=$(cat "$PACKAGE_DIR/.last_B_sessionfile")
		anchor=$(cat "$tmpdir/anchor.txt" 2>/dev/null || true)
	fi
	if [[ -z "${anchor:-}" || -z "${sf:-}" || ! -f "$sf" ]]; then
		# Scenario C run independently — re-run B's setup.
		echo "C: replaying B as setup..." >&2
		scenario_B || { echo "C: setup (B) failed" >&2; return 1; }
		tmpdir=$(cat "$PACKAGE_DIR/.last_B_tmpdir")
		sf=$(cat "$PACKAGE_DIR/.last_B_sessionfile")
		anchor=$(cat "$tmpdir/anchor.txt")
	fi

	local sd="$tmpdir/sess"
	pi_turn "$sd" "$sf" "$tmpdir/logs/turn3.jsonl" \
		"Call context-bonsai-retrieve with anchor_id $anchor right now."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "turn3 nonzero exit" "$tmpdir"; return 1; }

	local result
	result=$(node_assert "
		import { eventStreamToolResult, sessionHasCustomEntry } from '$ASSERT_MJS';
		const log = '$tmpdir/logs/turn3.jsonl';
		const sess = '$sf';
		const errors = [];
		const r = eventStreamToolResult(log, 'context-bonsai-retrieve');
		if (!r) errors.push('no tool_execution_end for retrieve');
		else {
			if (r.isError) errors.push('retrieve isError=true: ' + JSON.stringify(r.content));
			else if (!r.content[0] || !r.content[0].text || !r.content[0].text.startsWith('Restored ')) {
				errors.push('retrieve content did not start with Restored: ' + JSON.stringify(r.content));
			}
		}
		const clears = sessionHasCustomEntry(sess, 'context-bonsai:archive-clear');
		if (clears.length !== 1) errors.push('expected 1 archive-clear entry, got ' + clears.length);
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		emit_verdict "$name" PASS "" "$tmpdir"
		rm -f "$PACKAGE_DIR/.last_B_tmpdir" "$PACKAGE_DIR/.last_B_sessionfile"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

scenario_D() {
	local name="D"
	local tmpdir
	tmpdir=$(mktemp -d -t pi-bonsai-D-XXXX)
	mkdir -p "$tmpdir/logs"
	local sd="$tmpdir/sess"

	# Reproduce B's prune-only state in a clean tmpdir.
	pi_turn "$sd" "" "$tmpdir/logs/turn1.jsonl" \
		"Remember these three facts as completed reference material: alpha=red, beta=green, gamma=blue. Acknowledge briefly."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "setup turn1 nonzero exit" "$tmpdir"; return 1; }
	local sf
	sf=$(pi_session_file "$sd")
	[[ -z "$sf" ]] && { emit_verdict "$name" FAIL "no session file" "$tmpdir"; return 1; }

	pi_turn "$sd" "$sf" "$tmpdir/logs/turn2.jsonl" \
		"Call context-bonsai-prune now. from_pattern \"alpha=red\", to_pattern \"gamma=blue\", summary \"completed reference facts\", index_terms [\"alpha\",\"beta\",\"gamma\",\"colors\"]."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "setup turn2 nonzero exit" "$tmpdir"; return 1; }

	# New process — same --session.
	pi_turn "$sd" "$sf" "$tmpdir/logs/reload.jsonl" "noop"
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "reload turn nonzero exit" "$tmpdir"; return 1; }

	local result
	result=$(node_assert "
		import { countMatchesInEventStream, sessionHasCustomEntry } from '$ASSERT_MJS';
		const log = '$tmpdir/logs/reload.jsonl';
		const sess = '$sf';
		const errors = [];
		if (countMatchesInEventStream(log, /\"type\":\"agent_end\"/) < 1) errors.push('reload turn missing agent_end');
		const archives = sessionHasCustomEntry(sess, 'context-bonsai:archive');
		const clears = sessionHasCustomEntry(sess, 'context-bonsai:archive-clear');
		if (archives.length !== 1) errors.push('expected 1 archive after reload, got ' + archives.length);
		if (clears.length !== 0) errors.push('expected 0 archive-clear after reload, got ' + clears.length);
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		emit_verdict "$name" PASS "" "$tmpdir"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

scenario_E() {
	local name="E"
	local tmpdir
	tmpdir=$(mktemp -d -t pi-bonsai-E-XXXX)
	mkdir -p "$tmpdir/logs"
	local sd="$tmpdir/sess"
	local sf=""

	for n in 1 2 3 4 5 6 7 8 9 10; do
		pi_turn "$sd" "$sf" "$tmpdir/logs/turn${n}.jsonl" "turn $n"
		[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "turn $n nonzero exit" "$tmpdir"; return 1; }
		if [[ -z "$sf" ]]; then
			sf=$(pi_session_file "$sd")
		fi
	done

	cat "$tmpdir/logs/turn"*.jsonl > "$tmpdir/logs/concat.jsonl"

	local result
	result=$(node_assert "
		import { countMatchesInEventStream } from '$ASSERT_MJS';
		const log = '$tmpdir/logs/concat.jsonl';
		const errors = [];
		const gauges = countMatchesInEventStream(log, /\\\\[CONTEXT GAUGE:/);
		if (gauges < 2) errors.push('expected at least 2 gauge markers, got ' + gauges);
		// Sanity: at least one gauge inside a message_end-bearing user message.
		const userMsgGauges = countMatchesInEventStream(log, /\"role\":\"user\"[\s\S]*?\\\\[CONTEXT GAUGE:/);
		if (userMsgGauges < 1) errors.push('no gauge marker on a user message line');
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		emit_verdict "$name" PASS "" "$tmpdir"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

scenario_F() {
	local name="F"
	local tmpdir
	tmpdir=$(mktemp -d -t pi-bonsai-F-XXXX)
	mkdir -p "$tmpdir/logs"
	local sd="$tmpdir/sess"

	pi_turn "$sd" "" "$tmpdir/logs/turn1.jsonl" \
		"Remember these three facts as completed reference material: alpha=red, beta=green, gamma=blue. Acknowledge briefly."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "setup turn1 nonzero exit" "$tmpdir"; return 1; }
	local sf
	sf=$(pi_session_file "$sd")
	[[ -z "$sf" ]] && { emit_verdict "$name" FAIL "no session file" "$tmpdir"; return 1; }

	pi_turn "$sd" "$sf" "$tmpdir/logs/turn2.jsonl" \
		"In a SINGLE response, call context-bonsai-prune (from_pattern \"alpha=red\", to_pattern \"gamma=blue\", summary \"facts\", index_terms [\"alpha\",\"beta\",\"gamma\"]), then immediately call context-bonsai-retrieve with the anchor_id from the prune result."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "turn2 nonzero exit" "$tmpdir"; return 1; }

	pi_turn "$sd" "$sf" "$tmpdir/logs/turn3.jsonl" "what color is alpha? answer in one word."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "turn3 nonzero exit" "$tmpdir"; return 1; }

	local result
	result=$(node_assert "
		import { eventStreamToolResult, sessionHasCustomEntry, countMatchesInEventStream } from '$ASSERT_MJS';
		const log2 = '$tmpdir/logs/turn2.jsonl';
		const log3 = '$tmpdir/logs/turn3.jsonl';
		const sess = '$sf';
		const errors = [];
		const prune = eventStreamToolResult(log2, 'context-bonsai-prune');
		if (!prune || prune.isError) errors.push('prune missing or error');
		else if (!prune.content[0]?.text?.startsWith('Archived ')) errors.push('prune did not start with Archived');
		const retrieve = eventStreamToolResult(log2, 'context-bonsai-retrieve');
		if (!retrieve || retrieve.isError) errors.push('retrieve missing or error');
		else if (!retrieve.content[0]?.text?.startsWith('Restored ')) errors.push('retrieve did not start with Restored');
		const archives = sessionHasCustomEntry(sess, 'context-bonsai:archive');
		const clears = sessionHasCustomEntry(sess, 'context-bonsai:archive-clear');
		if (archives.length < 1) errors.push('no archive entry');
		if (clears.length < 1) errors.push('no archive-clear entry');
		// After retrieve, the next turn's transcript must be un-elided: no
		// PRUNED placeholder marker should appear in turn3's event stream.
		const placeholders = countMatchesInEventStream(log3, /\\\\[PRUNED: /);
		if (placeholders > 0) errors.push('placeholder visible after same-turn retrieve (count=' + placeholders + ')');
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		emit_verdict "$name" PASS "" "$tmpdir"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

scenario_G() {
	local name="G"
	local tmpdir
	tmpdir=$(mktemp -d -t pi-bonsai-G-XXXX)
	mkdir -p "$tmpdir/logs"
	local sd="$tmpdir/sess"
	local nonce="OPENSESAME$$$(date +%s)"
	echo "$nonce" > "$tmpdir/nonce.txt"

	pi_turn "$sd" "" "$tmpdir/logs/turn1.jsonl" \
		"Please remember the following secret token verbatim for later recall: ${nonce}. The token will be required later. Acknowledge with one word."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "setup turn1 nonzero exit" "$tmpdir"; return 1; }
	local sf
	sf=$(pi_session_file "$sd")
	[[ -z "$sf" ]] && { emit_verdict "$name" FAIL "no session file" "$tmpdir"; return 1; }

	# Add an unrelated turn so the secret is not the most recent message.
	pi_turn "$sd" "$sf" "$tmpdir/logs/turn2.jsonl" \
		"Now talk about something unrelated. Briefly mention your favorite color in one word."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "filler turn2 nonzero exit" "$tmpdir"; return 1; }

	# Prune the secret-bearing range. Summary and index_terms intentionally
	# exclude the nonce.
	pi_turn "$sd" "$sf" "$tmpdir/logs/turn3.jsonl" \
		"Call context-bonsai-prune now. from_pattern \"remember the following secret token\", to_pattern \"favorite color\", summary \"earlier conversation about a token and a color\", index_terms [\"token\",\"color\",\"reference\"]."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "prune turn3 nonzero exit" "$tmpdir"; return 1; }

	# Now ask for the nonce. The model should not be able to recall it from
	# active context (only from the placeholder summary, which omits it).
	pi_turn "$sd" "$sf" "$tmpdir/logs/turn4.jsonl" \
		"What was the exact secret token from earlier? Answer with the token verbatim if you can recall it from currently visible context, otherwise say UNAVAILABLE."
	[[ $? -ne 0 ]] && { emit_verdict "$name" FAIL "recall turn4 nonzero exit" "$tmpdir"; return 1; }

	local result
	result=$(node_assert "
		import { countMatchesInEventStream, eventStreamToolResult } from '$ASSERT_MJS';
		const log4 = '$tmpdir/logs/turn4.jsonl';
		const NONCE = $(printf '%s' "$nonce" | node -e 'process.stdout.write(JSON.stringify(require(\"fs\").readFileSync(0,\"utf8\").trim()))');
		const errors = [];
		const re = new RegExp(NONCE.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\\$&'));
		// Turn 4's stream is the model-visible transcript after prune. The
		// nonce must not appear in any message_end content for an assistant
		// final-answer message. Use an indirect grep on the line text.
		const matches = countMatchesInEventStream(log4, re);
		if (matches > 0) errors.push('nonce leaked into post-prune transcript ' + matches + ' time(s)');
		// Also confirm the placeholder appears (sanity).
		const placeholders = countMatchesInEventStream(log4, /\\\\[PRUNED: /);
		if (placeholders < 1) errors.push('placeholder missing from post-prune turn');
		console.log(errors.length === 0 ? 'OK' : 'FAIL: ' + errors.join('; '));
	") || result="FAIL: node assert crashed"

	if [[ "$result" == OK ]]; then
		emit_verdict "$name" PASS "" "$tmpdir"
		return 0
	fi
	emit_verdict "$name" FAIL "${result#FAIL: }" "$tmpdir"
	return 1
}

# ---- dispatcher ----

run_one() {
	case "$1" in
		A) scenario_A ;;
		B) scenario_B ;;
		C) scenario_C ;;
		D) scenario_D ;;
		E) scenario_E ;;
		F) scenario_F ;;
		G) scenario_G ;;
		*) echo "run-e2e: unknown scenario '$1'" >&2; return 2 ;;
	esac
}

worst_rc=0
if [[ -n "$SCENARIO" ]]; then
	run_one "$SCENARIO"
	worst_rc=$?
else
	# --all: run A → B → C → D → E → F → G in order. Each scenario sets up its
	# own tmpdir; B/C share state through .last_B_* breadcrumbs.
	for s in A B C D E F G; do
		run_one "$s" || worst_rc=1
	done
fi

# Cleanup B-handoff breadcrumbs even on failure.
rm -f "$PACKAGE_DIR/.last_B_tmpdir" "$PACKAGE_DIR/.last_B_sessionfile"

exit "$worst_rc"
