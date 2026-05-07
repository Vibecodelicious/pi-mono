/**
 * Unit tests for the `context-bonsai-retrieve` tool factory.
 *
 * Coverage targets (per Story P.3 ACs):
 * - archive found → tombstone written + in-memory store cleared + success
 *   string echoes anchor and range-end ids.
 * - archive absent → deterministic `Error: No archive found for message ...`.
 * - same-turn prune+retrieve → both archive and archive-clear entries are
 *   appended in order, and `hydrateFromEntries` honours tombstone precedence.
 * - fail-closed when `pi.appendEntry` is unavailable.
 * - executionMode is `sequential`.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { ArchiveStore } from "../src/archive-store.js";
import { createPruneTool } from "../src/prune.js";
import { createRetrieveTool } from "../src/retrieve.js";
import {
	ARCHIVE_CLEAR_CUSTOM_TYPE,
	ARCHIVE_CUSTOM_TYPE,
	type ArchiveClearRecord,
	type ArchiveRecord,
} from "../src/schema.js";
import { createState } from "../src/state.js";

let entryCounter = 0;
function nextEntryId(): string {
	const id = `e${entryCounter}`;
	entryCounter += 1;
	return id;
}

function userMsgEntry(text: string, timestamp: number): SessionEntry {
	const id = nextEntryId();
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	} as unknown as SessionEntry;
}

function archive(anchor: string, end: string, summary = "s", indexTerms = ["k1"]): ArchiveRecord {
	return {
		anchorEntryId: anchor,
		anchorRole: "user",
		anchorTimestamp: 1000,
		rangeEndEntryId: end,
		rangeEndRole: "assistant",
		rangeEndTimestamp: 2000,
		summary,
		indexTerms,
		createdInTurn: 0,
	};
}

interface CapturedAppend {
	customType: string;
	data: unknown;
}

function makeStubPi(captured: CapturedAppend[]): ExtensionAPI {
	return {
		appendEntry: (customType: string, data?: unknown) => {
			captured.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
}

function makeStubCtx(branch: SessionEntry[]): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
		},
	} as unknown as ExtensionContext;
}

describe("createRetrieveTool", () => {
	test("tool defines name, description, and executionMode: sequential", () => {
		const tool = createRetrieveTool({} as ExtensionAPI, new ArchiveStore());
		expect(tool.name).toBe("context-bonsai-retrieve");
		expect(tool.executionMode).toBe("sequential");
		expect(typeof tool.description).toBe("string");
		expect((tool.description as string).length).toBeGreaterThan(0);
	});

	test("returns deterministic error when archive is absent", async () => {
		entryCounter = 0;
		const captured: CapturedAppend[] = [];
		const pi = makeStubPi(captured);
		const store = new ArchiveStore();
		const tool = createRetrieveTool(pi, store);
		const result = await tool.execute("call-x", { anchor_id: "missing" }, undefined, undefined, makeStubCtx([]));
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toBe("Error: No archive found for message missing");
		// Importantly: no tombstone written when no archive existed.
		expect(captured).toHaveLength(0);
	});

	test("happy path: persists tombstone + clears in-memory store + success string", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha", 1000);
		const b = userMsgEntry("beta", 2000);
		const c = userMsgEntry("gamma", 3000);
		const captured: CapturedAppend[] = [];
		const pi = makeStubPi(captured);
		const store = new ArchiveStore();
		store.set({
			...archive(a.id, c.id, "did stuff", ["k1", "k2"]),
			anchorTimestamp: 1000,
			rangeEndTimestamp: 3000,
		});
		const tool = createRetrieveTool(pi, store);
		const result = await tool.execute("call-x", { anchor_id: a.id }, undefined, undefined, makeStubCtx([a, b, c]));
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toBe(`Restored 3 messages from range ${a.id} to ${c.id}. Original content is now visible.`);
		// Tombstone written.
		expect(captured).toHaveLength(1);
		expect(captured[0].customType).toBe(ARCHIVE_CLEAR_CUSTOM_TYPE);
		expect((captured[0].data as ArchiveClearRecord).anchorEntryId).toBe(a.id);
		// In-memory store cleared.
		expect(store.get(a.id)).toBeUndefined();
	});

	test("anchor === rangeEnd reports a count of 1", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha", 1000);
		const captured: CapturedAppend[] = [];
		const pi = makeStubPi(captured);
		const store = new ArchiveStore();
		store.set(archive(a.id, a.id));
		const tool = createRetrieveTool(pi, store);
		const result = await tool.execute("call-x", { anchor_id: a.id }, undefined, undefined, makeStubCtx([a]));
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toBe(`Restored 1 messages from range ${a.id} to ${a.id}. Original content is now visible.`);
	});

	test("compatibility error when pi.appendEntry is unavailable; archive state unchanged", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha", 1000);
		const store = new ArchiveStore();
		const original = archive(a.id, a.id);
		store.set(original);
		const piWithout = {} as unknown as ExtensionAPI;
		const tool = createRetrieveTool(piWithout, store);
		const result = await tool.execute("call-x", { anchor_id: a.id }, undefined, undefined, makeStubCtx([a]));
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/pi\.appendEntry is unavailable/);
		// In-memory state must be unchanged.
		expect(store.get(a.id)).toEqual(original);
	});

	test("appendEntry exception surfaces as deterministic plain-text error and leaves store intact", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha", 1000);
		const store = new ArchiveStore();
		const original = archive(a.id, a.id);
		store.set(original);
		const failingPi = {
			appendEntry: vi.fn(() => {
				throw new Error("disk full");
			}),
		} as unknown as ExtensionAPI;
		const tool = createRetrieveTool(failingPi, store);
		const result = await tool.execute("call-x", { anchor_id: a.id }, undefined, undefined, makeStubCtx([a]));
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/failed to persist tombstone: disk full/);
		// Store untouched on failure.
		expect(store.get(a.id)).toEqual(original);
	});

	test("rejects empty anchor_id with deterministic error", async () => {
		entryCounter = 0;
		const captured: CapturedAppend[] = [];
		const pi = makeStubPi(captured);
		const store = new ArchiveStore();
		const tool = createRetrieveTool(pi, store);
		const result = await tool.execute("call-x", { anchor_id: "" }, undefined, undefined, makeStubCtx([]));
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/anchor_id must be a non-empty string/);
		expect(captured).toHaveLength(0);
	});

	test("same-turn prune+retrieve: emits archive then archive-clear; tombstone-wins hydrate yields no archive", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha-msg", 1000);
		const b = userMsgEntry("middle", 2000);
		const c = userMsgEntry("end-msg", 3000);
		const captured: CapturedAppend[] = [];
		const pi = makeStubPi(captured);
		const store = new ArchiveStore();
		const pruneTool = createPruneTool(pi, store, createState());
		const retrieveTool = createRetrieveTool(pi, store);

		// 1) Prune in this turn.
		const pruneResult = await pruneTool.execute(
			"call-prune",
			{
				from_pattern: "alpha-msg",
				to_pattern: "end-msg",
				summary: "same-turn",
				index_terms: ["a", "b"],
			},
			undefined,
			undefined,
			makeStubCtx([a, b, c]),
		);
		const pruneText = (pruneResult.content[0] as { type: "text"; text: string }).text;
		expect(pruneText).toMatch(/^Archived 3 messages/);
		// 2) Retrieve in the same turn against the same anchor.
		const retrieveResult = await retrieveTool.execute(
			"call-retrieve",
			{ anchor_id: a.id },
			undefined,
			undefined,
			makeStubCtx([a, b, c]),
		);
		const retrieveText = (retrieveResult.content[0] as { type: "text"; text: string }).text;
		expect(retrieveText).toBe(`Restored 3 messages from range ${a.id} to ${c.id}. Original content is now visible.`);

		// Both writes were captured in order.
		expect(captured.map((c2) => c2.customType)).toEqual([ARCHIVE_CUSTOM_TYPE, ARCHIVE_CLEAR_CUSTOM_TYPE]);

		// Replay the captured entries through `hydrateFromEntries` to assert
		// tombstone-wins precedence: a fresh store hydrated from this captured
		// log must end up empty.
		const replayEntries: SessionEntry[] = captured.map((capture, idx) => ({
			type: "custom",
			customType: capture.customType,
			data: capture.data,
			id: `replay-${idx}`,
			parentId: null,
			timestamp: new Date(4000 + idx).toISOString(),
		})) as unknown as SessionEntry[];
		const replayStore = new ArchiveStore();
		replayStore.hydrateFromEntries(replayEntries);
		expect(replayStore.get(a.id)).toBeUndefined();

		// And the live store the prune+retrieve mutated should also be empty.
		expect(store.get(a.id)).toBeUndefined();
	});
});
