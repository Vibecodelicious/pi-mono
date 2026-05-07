/**
 * Port of `opencode_context_bonsai_plugin/src/prune-pattern.test.ts`
 * adapted to Pi's `SessionMessageEntry` shape. The pattern-matcher tests
 * are unchanged from OpenCode (same heuristic chain). The corpus and
 * resolve-boundary tests are rewritten against Pi's `SessionMessageEntry +
 * pi-ai Message` shape, with the new requirement that the corpus include
 * tool-call name, input, AND output for completed tool calls (Pattern
 * Matching Contract bullet 1, MUST).
 */

import type { SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
	buildMessageSearchCorpus,
	buildToolResultIndex,
	resolvePatternBoundary,
	stableSerialize,
} from "../src/prune-pattern.js";
import { messageMatchesPattern } from "../src/prune-pattern-matcher.js";

let counter = 0;
function nextId(prefix = "e"): string {
	counter += 1;
	return `${prefix}${counter}`;
}

function userEntry(text: string, id?: string, timestamp = 1000): SessionMessageEntry {
	return {
		type: "message",
		id: id ?? nextId("u"),
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "user",
			content: text,
			timestamp,
		},
	} as unknown as SessionMessageEntry;
}

function assistantTextEntry(text: string, id?: string, timestamp = 2000): SessionMessageEntry {
	return {
		type: "message",
		id: id ?? nextId("a"),
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		},
	} as unknown as SessionMessageEntry;
}

function assistantToolCallEntry(
	toolName: string,
	args: Record<string, unknown>,
	callId: string,
	id?: string,
	timestamp = 2000,
	wrapperText = "",
): SessionMessageEntry {
	const content: Array<{ type: string; [k: string]: unknown }> = [];
	if (wrapperText) {
		content.push({ type: "text", text: wrapperText });
	}
	content.push({ type: "toolCall", id: callId, name: toolName, arguments: args });
	return {
		type: "message",
		id: id ?? nextId("a"),
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp,
		},
	} as unknown as SessionMessageEntry;
}

function toolResultEntry(
	callId: string,
	toolName: string,
	output: unknown,
	id?: string,
	timestamp = 2100,
): SessionMessageEntry {
	const content =
		typeof output === "string" ? [{ type: "text", text: output }] : [{ type: "text", text: JSON.stringify(output) }];
	return {
		type: "message",
		id: id ?? nextId("r"),
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content,
			isError: false,
			timestamp,
		},
	} as unknown as SessionMessageEntry;
}

describe("prune pattern utilities", () => {
	test("stableSerialize sorts object keys and handles non-JSON values deterministically", () => {
		const fn = () => "noop";
		const symbol = Symbol("s");

		const value = {
			z: 3,
			a: {
				keep: 1,
				dropUndefined: undefined,
				dropFn: fn,
				dropSymbol: symbol,
				nested: { b: 2, a: 1 },
			},
			arr: [1, undefined, fn, symbol, 7n, { y: 2, x: 1 }],
		};

		expect(stableSerialize(value)).toBe(
			'{"a":{"keep":1,"nested":{"a":1,"b":2}},"arr":[1,null,null,null,"7",{"x":1,"y":2}],"z":3}',
		);
	});

	test("stableSerialize uses strict lexicographic key ordering", () => {
		const value = { a: 1, A: 2, _: 3 };

		expect(stableSerialize(value)).toBe('{"A":2,"_":3,"a":1}');
	});

	test("buildMessageSearchCorpus includes user text", () => {
		const entry = userEntry("hello world");
		const corpus = buildMessageSearchCorpus(entry, new Map());
		expect(corpus).toContain("text:hello world");
	});

	test("buildMessageSearchCorpus includes assistant text", () => {
		const entry = assistantTextEntry("visible text");
		const corpus = buildMessageSearchCorpus(entry, new Map());
		expect(corpus).toContain("text:visible text");
	});

	test("buildMessageSearchCorpus includes completed tool name + stable input + output", () => {
		const callId = "call-1";
		const assistant = assistantToolCallEntry("grep", { z: 2, a: 1 }, callId, "a1", 2000, "calling grep");
		const result = toolResultEntry(callId, "grep", { ok: true }, "r1", 2100);
		const idx = buildToolResultIndex([assistant, result]);
		const corpus = buildMessageSearchCorpus(assistant, idx);
		expect(corpus).toContain("text:calling grep");
		expect(corpus).toContain("tool:grep");
		expect(corpus).toContain('input:{"a":1,"z":2}');
		// Output for our shape comes through as a JSON-stringified text part.
		expect(corpus).toContain("output:");
		expect(corpus).toContain("ok");
	});

	test("buildMessageSearchCorpus skips tool calls without a matching toolResult (incomplete)", () => {
		const assistant = assistantToolCallEntry("bash", { cmd: "ls" }, "call-2", "a2", 2000);
		const corpus = buildMessageSearchCorpus(assistant, new Map());
		// no result -> skip
		expect(corpus).not.toContain("tool:bash");
	});

	test("message matching requires corpus containment for a heuristic candidate", () => {
		const corpus = "alpha\nbeta";
		const pattern = " alpha \n beta ";
		expect(messageMatchesPattern(corpus, pattern)).toBe(true);
	});

	test("resolvePatternBoundary returns deterministic miss + ambiguity errors", () => {
		const e1 = userEntry("shared content", "u1", 1000);
		const e2 = assistantTextEntry("shared content", "a1", 2000);

		expect(() => resolvePatternBoundary([e1, e2], "missing")).toThrow('No messages match "missing"');
		expect(() => resolvePatternBoundary([e1, e2], "shared content")).toThrow(
			'2 messages match "shared content"; use a more precise pattern',
		);
	});

	test("resolvePatternBoundary can match completed tool output content", () => {
		const e1 = userEntry("plain text", "u1", 1000);
		const callId = "call-1";
		const e2 = assistantToolCallEntry("bash", { cmd: "bun test", retries: 2 }, callId, "a1", 2000);
		const e3 = toolResultEntry(callId, "bash", { status: "ok", lines: ["pass"] }, "r1", 2100);

		expect(resolvePatternBoundary([e1, e2, e3], "tool:bash")).toBe("a1");
		expect(resolvePatternBoundary([e1, e2, e3], '"retries":2')).toBe("a1");
		expect(resolvePatternBoundary([e1, e2, e3], '"status":"ok"')).toBe("a1");
	});

	test("resolvePatternBoundary selects the single non-prune candidate when ambiguity includes prune calls", () => {
		// Prior failed prune call A: echoed "shared boundary" inside its input.
		const callA = "callA";
		const wrapperA = assistantToolCallEntry(
			"context-bonsai-prune",
			{ from_pattern: "shared boundary", to_pattern: "x", summary: "y", index_terms: ["z"] },
			callA,
			"a1",
			2000,
		);
		const wrapperAResult = toolResultEntry(
			callA,
			"context-bonsai-prune",
			"validation error: shared boundary",
			"r1",
			2100,
		);

		// The real boundary message.
		const realBoundary = userEntry("shared boundary", "u1", 3000);

		// Another failed prune call B: echoed "shared boundary" inside its input.
		const callB = "callB";
		const wrapperB = assistantToolCallEntry(
			"context-bonsai-prune",
			{ from_pattern: "x", to_pattern: "shared boundary", summary: "y", index_terms: ["z"] },
			callB,
			"a2",
			4000,
		);
		const wrapperBResult = toolResultEntry(
			callB,
			"context-bonsai-prune",
			"validation error: shared boundary",
			"r2",
			4100,
		);

		expect(
			resolvePatternBoundary([wrapperA, wrapperAResult, realBoundary, wrapperB, wrapperBResult], "shared boundary"),
		).toBe("u1");
	});

	test("resolvePatternBoundary preserves ambiguity error when multiple non-prune candidates match", () => {
		const e1 = userEntry("shared boundary", "u1", 1000);
		const e2 = assistantTextEntry("shared boundary", "a1", 2000);
		const callA = "callA";
		const wrapperA = assistantToolCallEntry(
			"context-bonsai-prune",
			{ from_pattern: "shared boundary" },
			callA,
			"a2",
			3000,
		);
		const wrapperAResult = toolResultEntry(callA, "context-bonsai-prune", "fail", "r1", 3100);

		expect(() => resolvePatternBoundary([e1, e2, wrapperA, wrapperAResult], "shared boundary")).toThrow(
			/messages match "shared boundary"; use a more precise pattern/,
		);
	});

	test("resolvePatternBoundary preserves ambiguity error when all matches are prune candidates", () => {
		const callA = "callA";
		const wrapperA = assistantToolCallEntry(
			"context-bonsai-prune",
			{ from_pattern: "shared boundary" },
			callA,
			"a1",
			1000,
		);
		const wrapperAResult = toolResultEntry(callA, "context-bonsai-prune", "fail", "r1", 1100);
		const callB = "callB";
		const wrapperB = assistantToolCallEntry(
			"context-bonsai-prune",
			{ to_pattern: "shared boundary" },
			callB,
			"a2",
			2000,
		);
		const wrapperBResult = toolResultEntry(callB, "context-bonsai-prune", "fail", "r2", 2100);

		expect(() =>
			resolvePatternBoundary([wrapperA, wrapperAResult, wrapperB, wrapperBResult], "shared boundary"),
		).toThrow(/messages match "shared boundary"; use a more precise pattern/);
	});
});
