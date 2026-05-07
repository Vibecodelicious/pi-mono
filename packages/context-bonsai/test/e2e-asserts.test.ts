/**
 * Unit tests for the e2e assertion matchers in `test/e2e/assert.mjs`.
 *
 * These matchers are the only piece of the e2e harness that operates on
 * synthetic JSONL — every other piece requires a live LLM call. The fixtures
 * under `test/e2e/fixtures/` mimic the shape that `pi -p --mode json` and the
 * SessionManager produce, so we can validate matcher correctness without any
 * provider credentials. When the live harness runs, these matchers consume
 * real captured logs in the same shape.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	countMatchesInEventStream,
	eventStreamContainsTool,
	eventStreamToolResult,
	sessionHasCustomEntry,
	sessionHasMessageMatching,
} from "./e2e/assert.mjs";

const fixturesUrl = (name: string) => fileURLToPath(new URL(`./e2e/fixtures/${name}`, import.meta.url));

describe("eventStreamContainsTool", () => {
	test("returns true when tool_execution_end carries the toolName", () => {
		expect(eventStreamContainsTool(fixturesUrl("event-stream-prune.jsonl"), "context-bonsai-prune")).toBe(true);
	});

	test("returns false for a tool that never appears", () => {
		expect(eventStreamContainsTool(fixturesUrl("event-stream-prune.jsonl"), "context-bonsai-retrieve")).toBe(false);
	});

	test("returns true via assistant message_end toolCall content fallback", () => {
		// The prune fixture also has a toolCall content part on the assistant
		// message; even if execution events were stripped, the matcher should
		// still find the call via the message_end content scan.
		expect(eventStreamContainsTool(fixturesUrl("event-stream-prune.jsonl"), "context-bonsai-prune")).toBe(true);
	});
});

describe("eventStreamToolResult", () => {
	test("returns isError=false and the success content for the prune fixture", () => {
		const result = eventStreamToolResult(fixturesUrl("event-stream-prune.jsonl"), "context-bonsai-prune");
		expect(result).not.toBeNull();
		expect(result?.isError).toBe(false);
		expect(result?.content[0].text).toMatch(/^Archived /);
	});

	test("returns isError=true and the error content for the error fixture", () => {
		const result = eventStreamToolResult(fixturesUrl("event-stream-error.jsonl"), "context-bonsai-retrieve");
		expect(result).not.toBeNull();
		expect(result?.isError).toBe(true);
		expect(result?.content[0].text).toMatch(/No archive found/);
	});

	test("returns null when no tool_execution_end matches", () => {
		expect(eventStreamToolResult(fixturesUrl("event-stream-prune.jsonl"), "no-such-tool")).toBeNull();
	});
});

interface AnchorPayload {
	anchorEntryId: string;
}

describe("sessionHasCustomEntry", () => {
	test("returns the archive custom entries", () => {
		const entries = sessionHasCustomEntry<AnchorPayload>(
			fixturesUrl("session-archive.jsonl"),
			"context-bonsai:archive",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].data.anchorEntryId).toBe("msg1");
	});

	test("returns the archive-clear tombstone", () => {
		const entries = sessionHasCustomEntry<AnchorPayload>(
			fixturesUrl("session-archive-clear.jsonl"),
			"context-bonsai:archive-clear",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].data.anchorEntryId).toBe("msg1");
	});

	test("returns empty array when customType absent", () => {
		expect(sessionHasCustomEntry(fixturesUrl("session-archive.jsonl"), "context-bonsai:archive-clear")).toHaveLength(
			0,
		);
	});
});

describe("sessionHasMessageMatching", () => {
	test("predicate fires on a matching message", () => {
		const found = sessionHasMessageMatching(fixturesUrl("session-archive.jsonl"), (m) => {
			return (m as { role?: string })?.role === "assistant";
		});
		expect(found).toBe(true);
	});

	test("predicate that never matches returns false", () => {
		const found = sessionHasMessageMatching(fixturesUrl("session-archive.jsonl"), () => false);
		expect(found).toBe(false);
	});

	test("predicate that throws is treated as no-match, not a failure", () => {
		const found = sessionHasMessageMatching(fixturesUrl("session-archive.jsonl"), () => {
			throw new Error("predicate boom");
		});
		expect(found).toBe(false);
	});
});

describe("countMatchesInEventStream", () => {
	test("counts gauge marker occurrences", () => {
		// Two raw lines in the gauge fixture mention the gauge marker (one
		// message_start, one message_end), each on its own JSONL line.
		expect(countMatchesInEventStream(fixturesUrl("event-stream-gauge.jsonl"), /\[CONTEXT GAUGE:/)).toBe(2);
	});

	test("returns 0 when nothing matches", () => {
		expect(countMatchesInEventStream(fixturesUrl("event-stream-gauge.jsonl"), /this-string-not-in-fixture/)).toBe(0);
	});
});
