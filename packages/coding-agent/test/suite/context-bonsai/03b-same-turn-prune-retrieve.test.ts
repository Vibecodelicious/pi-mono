/**
 * Integration test for Story P.3 — same-turn prune+retrieve no-op (Pi
 * intentionally does NOT port OpenCode's same-step guard).
 *
 * The faux provider emits a single assistant message with TWO tool-calls
 * in the same batch: prune followed by retrieve, against the same anchor.
 * Both tool results must succeed; the session file must record one
 * `context-bonsai:archive` entry and one `context-bonsai:archive-clear`
 * entry; and the next `"context"` event must deliver the original
 * un-elided transcript (tombstone-wins precedence).
 */

import { type Context, fauxAssistantMessage, fauxToolCall, type Message } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("context-bonsai Story P.3: 03b-same-turn-prune-retrieve", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("prune+retrieve in one assistant batch: both succeed; tombstone wins; original transcript remains visible", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["context-bonsai-prune", "context-bonsai-retrieve"]);

		let timestampCursor = 1000;
		const nextTs = () => timestampCursor++;
		const seenContexts: Context[] = [];

		// Step 1: seed three assistant blocks so we have a contiguous range
		// to prune. Step 2: have the assistant emit ONE message that
		// contains both a prune toolCall and a retrieve toolCall against
		// the same anchor. Pi resolves the anchor entry id from the prune
		// success-text by reading the `context-bonsai:archive` custom entry
		// the prune tool persists — but the model in this test doesn't have
		// that information at prompt-construction time. We work around it by
		// (a) running the prune in turn 1, (b) reading the persisted archive
		// id, (c) emitting the SAME-batch prune+retrieve in turn 2 against
		// fresh content, using the live archive id discovered after step
		// (b) — i.e. we drive the same-turn race directly on a second
		// archive whose anchor id we resolve immediately before the
		// assistant reply.
		harness.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("first block", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("anchor block", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("range-end block", { timestamp: nextTs() });
			},
		]);
		await harness.session.prompt("u1");
		await harness.session.prompt("u2");
		await harness.session.prompt("u3");

		// Now the assistant's NEXT message emits prune AND retrieve in one
		// tool-call batch. Retrieve needs an anchor_id, but the archive
		// hasn't been written yet at the moment we construct this faux
		// response. We therefore resolve the anchor entry by inspecting the
		// branch entries that match the from_pattern at faux-response time:
		// the first user/assistant entry whose message content matches
		// "anchor block" — that's the entry id the prune tool will resolve
		// to and write the archive against. This is exactly the
		// information the model would have in a real run via the
		// `context-bonsai-prune` success-text on the next turn, but here we
		// exercise the SAME assistant message — so we must commit to an
		// anchor_id up-front.
		const branchEntries = harness.sessionManager.getBranch();
		let anchorEntryId: string | undefined;
		for (const e of branchEntries) {
			if (e.type !== "message") continue;
			const message = (e as { message?: { role?: string; content?: unknown } }).message;
			if (!message) continue;
			if (message.role !== "assistant") continue;
			const content = message.content;
			let asText = "";
			if (typeof content === "string") asText = content;
			else if (Array.isArray(content)) {
				asText = (content as Array<{ type?: string; text?: string }>)
					.map((p) => (p.type === "text" ? (p.text ?? "") : ""))
					.join("");
			}
			if (asText.includes("anchor block")) {
				anchorEntryId = e.id;
				break;
			}
		}
		expect(anchorEntryId).toBeDefined();

		harness.appendResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context-bonsai-prune",
							{
								from_pattern: "anchor block",
								to_pattern: "range-end block",
								summary: "same-turn target",
								index_terms: ["a1", "a2"],
							},
							{ id: "tc-prune-3b" },
						),
						fauxToolCall(
							"context-bonsai-retrieve",
							{ anchor_id: anchorEntryId as string },
							{ id: "tc-retrieve-3b" },
						),
					],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-same-turn ack", { timestamp: nextTs() });
			},
		]);
		await harness.session.prompt("u4-same-turn");

		// Both custom entries persisted, in append order.
		const customEntries = harness.sessionManager
			.getEntries()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" &&
					(e.customType === "context-bonsai:archive" || e.customType === "context-bonsai:archive-clear"),
			);
		const archiveEntries = customEntries.filter((e) => e.customType === "context-bonsai:archive");
		const clearEntries = customEntries.filter((e) => e.customType === "context-bonsai:archive-clear");
		expect(archiveEntries).toHaveLength(1);
		expect(clearEntries).toHaveLength(1);
		// The archive must have been written before the clear.
		const archiveIdx = customEntries.findIndex((e) => e.customType === "context-bonsai:archive");
		const clearIdx = customEntries.findIndex((e) => e.customType === "context-bonsai:archive-clear");
		expect(archiveIdx).toBeLessThan(clearIdx);
		expect((clearEntries[0].data as { anchorEntryId: string }).anchorEntryId).toBe(anchorEntryId);

		// Inspect the toolResults emitted on the same turn. Both must report
		// success: prune returns "Archived ..." and retrieve returns
		// "Restored ...".
		const postContext = seenContexts[seenContexts.length - 1];
		const toolResultsTextDump = JSON.stringify(
			postContext.messages.filter((m) => (m as { role?: string }).role === "toolResult"),
		);
		expect(toolResultsTextDump).toMatch(/Archived \d+ messages/);
		expect(toolResultsTextDump).toMatch(/Restored \d+ messages from range \S+ to \S+/);

		// Tombstone-wins: the post-turn `"context"` event has the original
		// "anchor block" + "range-end block" assistant content visible —
		// NOT the placeholder.
		const transcriptText = postContext.messages.map(messageText).join("\n---\n");
		expect(transcriptText).not.toMatch(new RegExp(`\\[PRUNED: ${anchorEntryId} to \\S+\\]`));
		expect(transcriptText).toMatch(/assistant:anchor block/);
		expect(transcriptText).toMatch(/assistant:range-end block/);
	});
});

function messageText(message: Message): string {
	if (typeof message.content === "string") {
		return `${message.role}:${message.content}`;
	}
	const parts = message.content as Array<{ type: string; text?: string; name?: string }>;
	return `${message.role}:${parts
		.map((p) => {
			if (p.type === "text") return p.text ?? "";
			if (p.type === "toolCall") return `[toolCall:${p.name}]`;
			return `[${p.type}]`;
		})
		.join("|")}`;
}
