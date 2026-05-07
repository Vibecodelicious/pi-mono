/**
 * Unit tests for the `context-bonsai-prune` tool's validation paths.
 *
 * We exercise the tool's `execute` directly with a hand-built `ExtensionAPI`
 * + `ExtensionContext`. This lets us test fail-closed behavior, missing
 * primitives, and validation errors without standing up a full Pi harness.
 *
 * Story 02 specifically requires:
 * - non-empty summary / index_terms
 * - from-precedes-to ordering
 * - boundaries not inside an already-pruned range
 * - no incomplete tool calls in range
 * - fail-closed when sessionManager.getBranch / pi.appendEntry are missing
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { ArchiveStore } from "../src/archive-store.js";
import { createPruneTool, type PruneToolInput } from "../src/prune.js";
import { ARCHIVE_CUSTOM_TYPE, type ArchiveRecord } from "../src/schema.js";
import { createState } from "../src/state.js";

let entryCounter = 0;
function nextEntryId(): string {
	const id = `e${entryCounter}`;
	entryCounter += 1;
	return id;
}
function defaultTs(): number {
	return 1000 + entryCounter * 10;
}
function userMsgEntry(text: string, timestamp?: number): SessionEntry {
	const id = nextEntryId();
	const ts = timestamp ?? defaultTs();
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: text, timestamp: ts },
	} as unknown as SessionEntry;
}
function assistantToolCallEntry(toolName: string, callId: string, args: unknown, timestamp?: number): SessionEntry {
	const id = nextEntryId();
	const ts = timestamp ?? defaultTs();
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
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
			timestamp: ts,
		},
	} as unknown as SessionEntry;
}
function toolResultEntry(callId: string, toolName: string, output: string, timestamp?: number): SessionEntry {
	const id = nextEntryId();
	const ts = timestamp ?? defaultTs();
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: ts,
		},
	} as unknown as SessionEntry;
}

function makeStubPi(captured: { args: unknown[] }): ExtensionAPI {
	return {
		appendEntry: (customType: string, data?: unknown) => {
			captured.args.push({ customType, data });
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

async function runPrune(opts: {
	branch: SessionEntry[];
	store?: ArchiveStore;
	params: PruneToolInput;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
}): Promise<string> {
	const captured = { args: [] as unknown[] };
	const pi = opts.pi ?? makeStubPi(captured);
	const tool = createPruneTool(pi, opts.store ?? new ArchiveStore(), createState());
	const result = await tool.execute("call-x", opts.params, undefined, undefined, opts.ctx ?? makeStubCtx(opts.branch));
	const text = (result.content[0] as { type: "text"; text: string }).text;
	return text;
}

describe("createPruneTool: validation", () => {
	test("rejects empty summary", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("alpha"), userMsgEntry("beta")];
		const text = await runPrune({
			branch,
			params: { from_pattern: "alpha", to_pattern: "beta", summary: "   ", index_terms: ["k"] },
		});
		expect(text).toMatch(/summary cannot be empty/);
	});

	test("rejects empty index_terms", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("alpha"), userMsgEntry("beta")];
		const text = await runPrune({
			branch,
			params: { from_pattern: "alpha", to_pattern: "beta", summary: "ok", index_terms: [] },
		});
		expect(text).toMatch(/index_terms cannot be empty/);
	});

	test("rejects whitespace-only index_terms entries", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("alpha"), userMsgEntry("beta")];
		const text = await runPrune({
			branch,
			params: { from_pattern: "alpha", to_pattern: "beta", summary: "ok", index_terms: ["a", "  "] },
		});
		expect(text).toMatch(/index_terms entries must be non-empty/);
	});

	test("rejects when from precedes to wrong way", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha");
		const b = userMsgEntry("beta");
		const text = await runPrune({
			branch: [a, b],
			// reverse: try to prune from beta back to alpha
			params: { from_pattern: "beta", to_pattern: "alpha", summary: "ok", index_terms: ["x"] },
		});
		expect(text).toMatch(/from_pattern must resolve to a message that precedes/);
	});

	test("rejects pattern miss with deterministic error", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("alpha"), userMsgEntry("beta")];
		const text = await runPrune({
			branch,
			params: { from_pattern: "nope", to_pattern: "beta", summary: "ok", index_terms: ["x"] },
		});
		expect(text).toMatch(/No messages match "nope"/);
	});

	test("rejects ambiguous pattern with deterministic error", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("ambig"), userMsgEntry("ambig"), userMsgEntry("end")];
		const text = await runPrune({
			branch,
			params: { from_pattern: "ambig", to_pattern: "end", summary: "ok", index_terms: ["x"] },
		});
		expect(text).toMatch(/messages match "ambig"; use a more precise pattern/);
	});

	test("rejects boundary that falls inside an already-pruned range", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha");
		const b = userMsgEntry("beta");
		const c = userMsgEntry("gamma");
		const store = new ArchiveStore();
		store.set({
			anchorEntryId: a.id,
			anchorRole: "user",
			anchorTimestamp: 1000,
			rangeEndEntryId: b.id,
			rangeEndRole: "user",
			rangeEndTimestamp: 1001,
			summary: "prior",
			indexTerms: ["k"],
			createdInTurn: 0,
		});
		const text = await runPrune({
			branch: [a, b, c],
			store,
			params: { from_pattern: "alpha", to_pattern: "gamma", summary: "ok", index_terms: ["x"] },
		});
		expect(text).toMatch(/already-pruned range/);
	});

	test("rejects range that cuts an incomplete tool call", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha");
		const callId = "tc-1";
		const aCall = assistantToolCallEntry("bash", callId, { cmd: "ls" });
		const aResult = toolResultEntry(callId, "bash", "ok");
		const tail = userMsgEntry("end");
		// Try to prune alpha..aCall, leaving aResult outside the range.
		const text = await runPrune({
			branch: [a, aCall, aResult, tail],
			params: {
				from_pattern: "alpha",
				to_pattern: "tool:bash",
				summary: "ok",
				index_terms: ["x"],
			},
		});
		expect(text).toMatch(/cuts through an incomplete tool call/);
	});

	test("rejects range whose toolResult is inside but its originating toolCall is OUTSIDE the range (orphan toolResult)", async () => {
		// Cross-agent spec MUST is direction-agnostic: a toolResult inside the
		// range whose originating toolCall is in an assistant entry BEFORE the
		// range is exactly the kind of incomplete-tool-call cut the validator
		// must reject. If allowed, the toolCall would remain visible to the
		// model with no matching result hidden inside the placeholder.
		entryCounter = 0;
		const head = userMsgEntry("head");
		const callId = "tc-orphan-1";
		// toolCall lives BEFORE the chosen range
		const aCall = assistantToolCallEntry("bash", callId, { cmd: "ls" });
		const middle = userMsgEntry("middle-anchor");
		// toolResult sits inside the range
		const aResult = toolResultEntry(callId, "bash", "ls-output");
		const tail = userMsgEntry("end-tail");
		const text = await runPrune({
			branch: [head, aCall, middle, aResult, tail],
			params: {
				from_pattern: "middle-anchor",
				to_pattern: "end-tail",
				summary: "ok",
				index_terms: ["x"],
			},
		});
		expect(text).toMatch(/orphan toolResult callId=tc-orphan-1/);
		expect(text).toMatch(/from_pattern must include the originating toolCall/);
	});

	test("happy path: persists archive + returns OpenCode-shaped success string", async () => {
		entryCounter = 0;
		const a = userMsgEntry("alpha-msg", 1000);
		const b = userMsgEntry("middle", 2000);
		const c = userMsgEntry("end-msg", 3000);
		const captured = { args: [] as unknown[] };
		const store = new ArchiveStore();
		const pi = makeStubPi(captured);
		const text = await runPrune({
			branch: [a, b, c],
			store,
			pi,
			params: {
				from_pattern: "alpha-msg",
				to_pattern: "end-msg",
				summary: "did stuff",
				index_terms: ["k1", "k2"],
				reason: "demo",
			},
		});
		expect(text).toMatch(/^Archived 3 messages/);
		expect(text).toContain('from pattern "alpha-msg"');
		expect(text).toContain('to pattern "end-msg"');
		expect(text).toContain("Summary: did stuff");
		expect(text).toContain("Index terms: k1, k2");
		// Persisted exactly one archive record.
		expect(captured.args).toHaveLength(1);
		const captured0 = captured.args[0] as { customType: string; data: ArchiveRecord };
		expect(captured0.customType).toBe(ARCHIVE_CUSTOM_TYPE);
		expect(captured0.data.anchorEntryId).toBe(a.id);
		expect(captured0.data.rangeEndEntryId).toBe(c.id);
		expect(captured0.data.anchorRole).toBe("user");
		expect(captured0.data.anchorTimestamp).toBe(1000);
		expect(captured0.data.rangeEndTimestamp).toBe(3000);
		expect(captured0.data.reason).toBe("demo");
		// Archive store updated.
		expect(store.get(a.id)?.summary).toBe("did stuff");
	});

	test("compatibility error when sessionManager.getBranch is unavailable", async () => {
		entryCounter = 0;
		const captured = { args: [] as unknown[] };
		const pi = makeStubPi(captured);
		const ctx = { sessionManager: {} } as unknown as ExtensionContext;
		const text = await runPrune({
			branch: [],
			pi,
			ctx,
			params: { from_pattern: "x", to_pattern: "y", summary: "s", index_terms: ["k"] },
		});
		expect(text).toMatch(/ctx\.sessionManager\.getBranch is unavailable/);
		expect(captured.args).toHaveLength(0);
	});

	test("compatibility error when pi.appendEntry is unavailable", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("alpha"), userMsgEntry("beta")];
		const ctx = makeStubCtx(branch);
		const piWithout = {} as unknown as ExtensionAPI;
		const tool = createPruneTool(piWithout, new ArchiveStore(), createState());
		const result = await tool.execute(
			"call-x",
			{ from_pattern: "alpha", to_pattern: "beta", summary: "s", index_terms: ["k"] },
			undefined,
			undefined,
			ctx,
		);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/pi\.appendEntry is unavailable/);
	});

	test("appendEntry exception is surfaced as a deterministic plain-text error", async () => {
		entryCounter = 0;
		const branch = [userMsgEntry("alpha"), userMsgEntry("beta")];
		const ctx = makeStubCtx(branch);
		const failingPi = {
			appendEntry: vi.fn(() => {
				throw new Error("disk full");
			}),
		} as unknown as ExtensionAPI;
		const tool = createPruneTool(failingPi, new ArchiveStore(), createState());
		const result = await tool.execute(
			"call-x",
			{ from_pattern: "alpha", to_pattern: "beta", summary: "s", index_terms: ["k"] },
			undefined,
			undefined,
			ctx,
		);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/failed to persist archive: disk full/);
	});

	test("tool defines executionMode: sequential", () => {
		const tool = createPruneTool({} as ExtensionAPI, new ArchiveStore(), createState());
		expect(tool.executionMode).toBe("sequential");
	});
});
