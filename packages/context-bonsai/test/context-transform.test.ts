/**
 * Unit tests for the `"context"` event handler. We exercise the
 * `(role, timestamp)` lookup directly against a hand-built `event.messages`
 * array — no harness needed.
 *
 * Key invariants under test:
 * - Anchor + range-end located by `(role, timestamp)` regardless of synthetics
 *   prepended/dropped by `buildSessionContext`.
 * - Skip silently when anchor/range-end is missing (compacted away or branch
 *   switched).
 * - Skip silently when the anchor entry is no longer on the current branch.
 * - Multiple archives applied in document order without index shift.
 * - Placeholder text matches the canonical
 *   `[PRUNED: <anchorEntryId> to <rangeEndEntryId>]\nSummary: ...\nIndex: ...`
 *   shape.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { ArchiveStore } from "../src/archive-store.js";
import { createContextHandler } from "../src/context-transform.js";
import type { ArchiveRecord } from "../src/schema.js";
import { createState } from "../src/state.js";

function makeArchive(opts: {
	anchorEntryId: string;
	anchorTimestamp: number;
	rangeEndEntryId: string;
	rangeEndTimestamp: number;
	anchorRole?: ArchiveRecord["anchorRole"];
	rangeEndRole?: ArchiveRecord["rangeEndRole"];
	summary?: string;
	indexTerms?: string[];
}): ArchiveRecord {
	return {
		anchorEntryId: opts.anchorEntryId,
		anchorRole: opts.anchorRole ?? "user",
		anchorTimestamp: opts.anchorTimestamp,
		rangeEndEntryId: opts.rangeEndEntryId,
		rangeEndRole: opts.rangeEndRole ?? "assistant",
		rangeEndTimestamp: opts.rangeEndTimestamp,
		summary: opts.summary ?? "did the thing",
		indexTerms: opts.indexTerms ?? ["k1", "k2"],
		createdInTurn: 0,
	};
}

function userMsg(text: string, ts: number): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as unknown as AgentMessage;
}

function assistantMsg(text: string, ts: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: ts,
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
	} as unknown as AgentMessage;
}

function syntheticCustomMsg(text: string, ts: number): AgentMessage {
	// Mimic buildSessionContext's branch-summary / compaction-summary
	// synthetics: a user-role wrapped message with a recognizable text part.
	return {
		role: "user",
		content: [{ type: "text", text: `[synthetic] ${text}` }],
		timestamp: ts,
	} as unknown as AgentMessage;
}

function fakeCtx(branchEntryIds: string[]): ExtensionContext {
	const entries: SessionEntry[] = branchEntryIds.map((id, i) => ({
		type: "message" as const,
		id,
		parentId: i === 0 ? null : branchEntryIds[i - 1],
		timestamp: new Date(1000 + i).toISOString(),
		message: { role: "user", content: "x", timestamp: 1000 + i },
	})) as unknown as SessionEntry[];
	return {
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

describe("createContextHandler", () => {
	test("locates anchor + range-end by (role, timestamp) and rewrites with placeholder", async () => {
		const store = new ArchiveStore();
		const archive = makeArchive({
			anchorEntryId: "e2",
			anchorTimestamp: 200,
			rangeEndEntryId: "e4",
			rangeEndTimestamp: 400,
			rangeEndRole: "assistant",
			summary: "summarised middle",
			indexTerms: ["mid"],
		});
		store.set(archive);

		const handler = createContextHandler(store, createState());
		const messages: AgentMessage[] = [
			userMsg("intro", 100), // not in archive (idx 0)
			userMsg("anchor-text", 200), // anchor (idx 1)
			userMsg("middle-1", 300),
			assistantMsg("range end text", 400),
			userMsg("after", 500),
		];
		const event: ContextEvent = { type: "context", messages };

		const result = await handler(event, fakeCtx(["e0", "e2", "e3", "e4", "e5"]));
		expect(result?.messages?.length).toBe(3); // 2 placeholders combined? actually intro + placeholder + after
		const out = result?.messages ?? [];
		expect((out[0] as { content?: unknown }).content).toBe("intro");
		const placeholder = out[1] as { content: Array<{ text: string }>; role: string; timestamp: number };
		expect(placeholder.role).toBe("user");
		expect(placeholder.timestamp).toBe(200);
		expect(placeholder.content[0].text).toContain("[PRUNED: e2 to e4]");
		expect(placeholder.content[0].text).toContain("Summary: summarised middle");
		expect(placeholder.content[0].text).toContain("Index: mid");
		expect((out[2] as { content?: unknown }).content).toBe("after");
	});

	test("skips silently when anchor cannot be located in event.messages", async () => {
		const store = new ArchiveStore();
		store.set(
			makeArchive({
				anchorEntryId: "e2",
				anchorTimestamp: 999, // no message has timestamp 999 in the transcript
				rangeEndEntryId: "e4",
				rangeEndTimestamp: 400,
			}),
		);

		const handler = createContextHandler(store, createState());
		const messages: AgentMessage[] = [userMsg("a", 100), userMsg("b", 200)];
		const event: ContextEvent = { type: "context", messages };
		const result = await handler(event, fakeCtx(["e2"]));
		expect(result).toBeUndefined();
	});

	test("skips silently when anchor entry is no longer on the current branch", async () => {
		const store = new ArchiveStore();
		store.set(
			makeArchive({
				anchorEntryId: "anchor-not-on-branch",
				anchorTimestamp: 200,
				rangeEndEntryId: "end",
				rangeEndTimestamp: 400,
			}),
		);

		const handler = createContextHandler(store, createState());
		const messages: AgentMessage[] = [userMsg("anchor-text", 200), assistantMsg("end", 400)];
		const event: ContextEvent = { type: "context", messages };
		// Branch no longer contains 'anchor-not-on-branch'.
		const result = await handler(event, fakeCtx(["different-branch"]));
		expect(result).toBeUndefined();
	});

	test("ignores buildSessionContext-style synthetics interleaved before anchor", async () => {
		const store = new ArchiveStore();
		store.set(
			makeArchive({
				anchorEntryId: "e2",
				anchorTimestamp: 200,
				rangeEndEntryId: "e4",
				rangeEndTimestamp: 400,
				rangeEndRole: "assistant",
			}),
		);
		const handler = createContextHandler(store, createState());

		// A synthetic compaction-summary user message at index 0 with a
		// timestamp that does NOT collide with the anchor.
		const messages: AgentMessage[] = [
			syntheticCustomMsg("compaction summary", 50),
			userMsg("anchor-text", 200),
			userMsg("middle", 300),
			assistantMsg("end", 400),
			userMsg("tail", 500),
		];
		const event: ContextEvent = { type: "context", messages };
		const result = await handler(event, fakeCtx(["e2"]));
		const out = result?.messages ?? [];
		expect(out.length).toBe(3);
		// synthetic preserved at index 0
		expect((out[0] as { content: Array<{ text: string }> }).content[0].text).toBe("[synthetic] compaction summary");
		// placeholder at index 1
		expect((out[1] as { content: Array<{ text: string }> }).content[0].text).toContain("[PRUNED: e2 to e4]");
		// tail preserved
		expect((out[2] as { content?: unknown }).content).toBe("tail");
	});

	test("multiple archives applied in document order", async () => {
		const store = new ArchiveStore();
		store.set(
			makeArchive({
				anchorEntryId: "e1",
				anchorTimestamp: 100,
				rangeEndEntryId: "e2",
				rangeEndTimestamp: 200,
				rangeEndRole: "user",
				summary: "first",
				indexTerms: ["one"],
			}),
		);
		store.set(
			makeArchive({
				anchorEntryId: "e4",
				anchorTimestamp: 400,
				rangeEndEntryId: "e5",
				rangeEndTimestamp: 500,
				rangeEndRole: "assistant",
				summary: "second",
				indexTerms: ["two"],
			}),
		);
		const handler = createContextHandler(store, createState());
		const messages: AgentMessage[] = [
			userMsg("first-anchor", 100),
			userMsg("first-end", 200),
			userMsg("middle", 300),
			userMsg("second-anchor", 400),
			assistantMsg("second-end", 500),
		];
		const event: ContextEvent = { type: "context", messages };
		const result = await handler(event, fakeCtx(["e1", "e2", "e3", "e4", "e5"]));
		const out = result?.messages ?? [];
		expect(out.length).toBe(3);
		expect((out[0] as { content: Array<{ text: string }> }).content[0].text).toContain("[PRUNED: e1 to e2]");
		expect((out[0] as { content: Array<{ text: string }> }).content[0].text).toContain("Summary: first");
		expect((out[1] as { content?: unknown }).content).toBe("middle");
		expect((out[2] as { content: Array<{ text: string }> }).content[0].text).toContain("[PRUNED: e4 to e5]");
	});

	test("returns undefined when no archives are active", async () => {
		const store = new ArchiveStore();
		const handler = createContextHandler(store, createState());
		const result = await handler({ type: "context", messages: [userMsg("a", 100)] }, fakeCtx(["e1"]));
		expect(result).toBeUndefined();
	});
});
