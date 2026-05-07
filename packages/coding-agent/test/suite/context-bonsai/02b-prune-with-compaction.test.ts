/**
 * Regression guard for the `buildSessionContext` divergence described in
 * Story P.2's Story Description: when the branch contains a `CompactionEntry`,
 * `buildSessionContext` injects a synthetic compaction-summary at the
 * beginning of `event.messages` and drops entries before
 * `firstKeptEntryId`.
 *
 * This test seeds a compaction directly via `SessionManager.appendCompaction`,
 * prunes a range AFTER the compaction, and asserts that the post-transform
 * transcript:
 * - keeps the compaction-summary synthetic undisturbed
 * - replaces the anchor message with the placeholder
 * - elides followers within the archive range
 *
 * The whole point: if we'd zip-aligned `getBranch().filter(e => e.type ===
 * "message")` against `event.messages`, we'd misidentify the anchor (because
 * the compaction-summary synthetic shifts positions and `firstKeptEntryId`
 * drops some entries). The `(role, timestamp)` lookup is robust against this.
 */

import { type Context, fauxAssistantMessage, fauxToolCall, type Message } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("context-bonsai Story P.2: 02b-prune-with-compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves synthetics and applies the placeholder at the right (role, timestamp) position", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["context-bonsai-prune"]);

		// Seed PRE-compaction messages directly so we can run a compaction over
		// them. Use unique numeric timestamps for deterministic correlation.
		const preTs1 = 100;
		const preTs2 = 200;
		harness.sessionManager.appendMessage({ role: "user", content: "pre-1", timestamp: preTs1 });
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "pre-1-reply" }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: preTs2,
		});

		// Append a compaction entry. firstKeptEntryId is the second of those
		// two messages so the user message before it is dropped.
		const entriesBeforeCompaction = harness.sessionManager.getEntries();
		const firstKeptId = entriesBeforeCompaction[1]!.id;
		harness.sessionManager.appendCompaction("compaction-summary-text", firstKeptId, 500, undefined, false);

		// Manually sync the agent's in-memory `state.messages` from
		// `buildSessionContext` so the compaction synthetic + the
		// `firstKeptEntryId` drop reach the LLM context. We avoid
		// `session.reload()` here because reload calls `resetApiProviders()`,
		// which un-registers the faux provider for the rest of the test.
		const sessionContext = harness.sessionManager.buildSessionContext();
		harness.session.agent.state.messages = sessionContext.messages;

		// Now the post-compaction "real" messages we want to potentially prune.
		let timestampCursor = 1000;
		const nextTs = () => timestampCursor++;
		const seenContexts: Context[] = [];
		harness.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("first-post", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("anchor-post", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("range-end-post", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context-bonsai-prune",
							{
								from_pattern: "anchor-post",
								to_pattern: "range-end-post",
								summary: "trimmed anchor..range-end",
								index_terms: ["x", "y"],
							},
							{ id: "tc-prune-2b" },
						),
					],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-prune", { timestamp: nextTs() });
			},
		]);

		await harness.session.prompt("p1");
		await harness.session.prompt("p2");
		await harness.session.prompt("p3");
		await harness.session.prompt("p4-prune");

		const post = seenContexts[seenContexts.length - 1];
		const transcriptText = post.messages.map((m) => `${m.role}:${textOf(m)}`).join("\n---\n");

		// Synthetic compaction summary survives at index 0.
		expect(transcriptText).toContain("compaction-summary-text");
		// Pre-compaction message dropped via firstKeptEntryId.
		expect(transcriptText).not.toMatch(/user:pre-1(\b|$|\n)/);
		// Placeholder injected.
		expect(transcriptText).toMatch(/\[PRUNED: \S+ to \S+\]\nSummary: trimmed anchor\.\.range-end\nIndex: x, y/);
		// Original "anchor-post" + "range-end-post" assistant messages are no longer at the assistant role.
		expect(transcriptText).not.toMatch(/assistant:anchor-post(\b|$|\n)/);
		expect(transcriptText).not.toMatch(/assistant:range-end-post(\b|$|\n)/);
	});
});

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const parts = message.content as Array<{ type: string; text?: string; name?: string }>;
	return parts
		.map((p) => {
			if (p.type === "text") return p.text ?? "";
			if (p.type === "toolCall") return `[toolCall:${p.name}]`;
			return `[${p.type}]`;
		})
		.join("|");
}
