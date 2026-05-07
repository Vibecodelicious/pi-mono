// E2E assertion helpers for the context-bonsai live-LLM protocol.
//
// These matchers are pure functions over JSONL files (the `--mode json` event
// stream captured to disk per turn, and the raw session JSONL Pi writes via
// SessionManager). They contain no Pi imports so the unit tests under
// `test/e2e/fixtures/` can drive them without spinning up the agent.
//
// Conventions:
// - "Event stream" log = stdout of `pi -p --mode json ...`, one JSON event per
//   line. Events conform to `AgentSessionEvent`
//   (packages/coding-agent/src/core/agent-session.ts:114) and the underlying
//   AgentEvent (packages/agent/src/types.ts:350-364).
// - "Session file" = `<sessionDir>/<ISO>_<uuid>.jsonl`. First line is
//   `SessionHeader`, subsequent lines are `SessionEntry` records (see
//   session-manager.ts:138-150).

import { readFileSync } from "node:fs";

function readJsonl(path) {
	const raw = readFileSync(path, "utf8");
	const lines = raw.split("\n");
	const out = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Skip malformed lines defensively. Pi writes JSONL atomically per
			// line (`appendFileSync`), but stdout capture can occasionally tear
			// on signal-driven exit; one bad line shouldn't flunk the matcher.
		}
	}
	return out;
}

/**
 * Returns true if any event in `pathToLog` is a `tool_execution_start` or
 * `tool_execution_end` for `toolName`, OR if any assistant `message_end` /
 * `turn_end` carries a `toolCall` content part with that name. The first two
 * are the cheapest positive signal; the message-content scan is a fallback for
 * cases where execution events are filtered (e.g. extension cancelled the
 * call).
 */
export function eventStreamContainsTool(pathToLog, toolName) {
	const events = readJsonl(pathToLog);
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue;
		if (
			(ev.type === "tool_execution_start" || ev.type === "tool_execution_end") &&
			ev.toolName === toolName
		) {
			return true;
		}
		if (ev.type === "message_end" || ev.type === "turn_end") {
			const message = ev.message;
			if (message && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part && part.type === "toolCall" && part.name === toolName) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

/**
 * Returns the result payload of the LAST `tool_execution_end` for `toolName`
 * in `pathToLog`. If no such event exists, returns `null`. The "last" choice
 * matters for retry sequences within a single turn — assertions almost always
 * care about the final outcome.
 *
 * Shape: `{ isError: boolean, content: Array<{type:"text", text:string}> }`.
 * `content` is normalised from the raw `result.content` (an
 * `AgentToolResult.content` list per agent/src/agent-loop.ts:651).
 */
export function eventStreamToolResult(pathToLog, toolName) {
	const events = readJsonl(pathToLog);
	let last = null;
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue;
		if (ev.type === "tool_execution_end" && ev.toolName === toolName) {
			last = ev;
		}
	}
	if (!last) return null;
	const result = last.result ?? {};
	const content = Array.isArray(result.content) ? result.content : [];
	return {
		isError: Boolean(last.isError),
		content,
	};
}

/**
 * Returns every `CustomEntry` in `sessionFile` whose `customType === customType`.
 * Used to assert that bonsai persisted an `archive` or `archive-clear` record
 * (`schema.ts:45-46`).
 */
export function sessionHasCustomEntry(sessionFile, customType) {
	const entries = readJsonl(sessionFile);
	const out = [];
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		if (e.type === "custom" && e.customType === customType) {
			out.push(e);
		}
	}
	return out;
}

/**
 * Returns true if any `SessionMessageEntry` in `sessionFile` has a `.message`
 * for which `predicate(message)` returns truthy. The predicate is invoked with
 * the raw `AgentMessage` object so callers can inspect `role`, `content`,
 * `timestamp`, etc.
 */
export function sessionHasMessageMatching(sessionFile, predicate) {
	const entries = readJsonl(sessionFile);
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		if (e.type !== "message") continue;
		try {
			if (predicate(e.message)) return true;
		} catch {
			// Predicate throwing on a malformed entry is treated as no-match,
			// not a matcher failure — the caller writes the predicate.
		}
	}
	return false;
}

/**
 * Returns the count of lines in `pathToLog` whose raw text matches `regex`.
 * Operates on the raw line text (not the parsed JSON) so callers can grep for
 * substrings that appear inside string fields (e.g. `"[CONTEXT GAUGE:"`).
 */
export function countMatchesInEventStream(pathToLog, regex) {
	const raw = readFileSync(pathToLog, "utf8");
	const lines = raw.split("\n");
	let count = 0;
	for (const line of lines) {
		if (line.length === 0) continue;
		if (regex.test(line)) count += 1;
	}
	return count;
}
