/**
 * Integration test for Story P.3 (retrieve).
 *
 * Sets up a faux-provider session, primes an existing archive via
 * `context-bonsai-prune`, then on a later turn calls
 * `context-bonsai-retrieve` against the same anchor and asserts:
 * (1) the next LLM call after retrieve sees the original un-elided
 *     transcript (placeholder gone, original messages back).
 * (2) the session file holds both a `context-bonsai:archive` entry and a
 *     `context-bonsai:archive-clear` tombstone in append order.
 * (3) reload (re-emit `session_start`, hydrate from entries) preserves the
 *     tombstone — the next post-reload turn still sees the un-elided
 *     transcript.
 */

import { type Context, fauxAssistantMessage, fauxToolCall, type Message } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("context-bonsai Story P.3: 03-retrieve", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retrieves a previously-pruned range and the next turn sees the original messages", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["context-bonsai-prune", "context-bonsai-retrieve"]);

		let timestampCursor = 1000;
		const nextTs = () => timestampCursor++;
		const seenContexts: Context[] = [];
		harness.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("first assistant block", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("second assistant block (target start)", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("third assistant block (target end)", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context-bonsai-prune",
							{
								from_pattern: "second assistant block (target start)",
								to_pattern: "third assistant block (target end)",
								summary: "target second+third",
								index_terms: ["second", "third"],
							},
							{ id: "tc-prune-3" },
						),
					],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
		]);

		await harness.session.prompt("u1");
		await harness.session.prompt("u2");
		await harness.session.prompt("u3");
		await harness.session.prompt("u4-prune");

		// Confirm the archive went in.
		const archiveEntries = harness.sessionManager
			.getEntries()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === "context-bonsai:archive",
			);
		expect(archiveEntries).toHaveLength(1);
		const archivedAnchorId = (archiveEntries[0].data as { anchorEntryId: string }).anchorEntryId;
		const archivedRangeEndId = (archiveEntries[0].data as { rangeEndEntryId: string }).rangeEndEntryId;

		// Now drive a turn that confirms the placeholder is in effect.
		harness.appendResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-prune ack", { timestamp: nextTs() });
			},
		]);
		await harness.session.prompt("u5-after-prune");
		const postPruneTranscript = seenContexts[seenContexts.length - 1].messages.map(messageText).join("\n---\n");
		expect(postPruneTranscript).toMatch(
			/\[PRUNED: \S+ to \S+\]\nSummary: target second\+third\nIndex: second, third/,
		);
		expect(postPruneTranscript).not.toMatch(/assistant:second assistant block \(target start\)/);
		expect(postPruneTranscript).not.toMatch(/assistant:third assistant block \(target end\)/);

		// On a later assistant turn, retrieve the archive.
		harness.appendResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage(
					[fauxToolCall("context-bonsai-retrieve", { anchor_id: archivedAnchorId }, { id: "tc-retrieve-3" })],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-retrieve ack", { timestamp: nextTs() });
			},
		]);
		await harness.session.prompt("u6-retrieve");

		// Tombstone is now persisted.
		const clearEntries = harness.sessionManager
			.getEntries()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === "context-bonsai:archive-clear",
			);
		expect(clearEntries).toHaveLength(1);
		expect((clearEntries[0].data as { anchorEntryId: string }).anchorEntryId).toBe(archivedAnchorId);

		// The transcript captured on the LLM call AFTER retrieve resolved has
		// the original un-elided messages back. seenContexts[last] is the
		// "post-retrieve ack" call.
		const postRetrieveTranscript = seenContexts[seenContexts.length - 1].messages.map(messageText).join("\n---\n");
		expect(postRetrieveTranscript).not.toMatch(
			new RegExp(`\\[PRUNED: ${archivedAnchorId} to ${archivedRangeEndId}\\]`),
		);
		expect(postRetrieveTranscript).toMatch(/assistant:second assistant block \(target start\)/);
		expect(postRetrieveTranscript).toMatch(/assistant:third assistant block \(target end\)/);

		// Reload the session: the tombstone must stick.
		await harness.session.reload();
		harness.appendResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-reload ack", { timestamp: nextTs() });
			},
		]);
		await harness.session.prompt("u7-after-reload");
		const postReloadTranscript = seenContexts[seenContexts.length - 1].messages.map(messageText).join("\n---\n");
		expect(postReloadTranscript).not.toMatch(
			new RegExp(`\\[PRUNED: ${archivedAnchorId} to ${archivedRangeEndId}\\]`),
		);
		expect(postReloadTranscript).toMatch(/assistant:second assistant block \(target start\)/);
		expect(postReloadTranscript).toMatch(/assistant:third assistant block \(target end\)/);
	});

	it("returns deterministic error string when retrieve targets an unknown anchor", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["context-bonsai-retrieve"]);

		let timestampCursor = 1000;
		const nextTs = () => timestampCursor++;
		const toolResultsSeen: Message[] = [];
		harness.setResponses([
			(_context) => {
				return fauxAssistantMessage(
					[fauxToolCall("context-bonsai-retrieve", { anchor_id: "does-not-exist" }, { id: "tc-retrieve-bad" })],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				// On the 2nd call we capture the toolResult that was emitted
				// from the first call. The toolResult lives in `context.messages`.
				for (const m of context.messages) {
					if ((m as { role?: string }).role === "toolResult") toolResultsSeen.push(m);
				}
				return fauxAssistantMessage("ack", { timestamp: nextTs() });
			},
		]);

		await harness.session.prompt("u1-retrieve-unknown");

		const flat = toolResultsSeen
			.map((m) => {
				const c = (m as { content?: unknown }).content;
				if (Array.isArray(c)) {
					return (c as Array<{ type?: string; text?: string }>)
						.map((p) => (p.type === "text" ? (p.text ?? "") : ""))
						.join("");
				}
				return typeof c === "string" ? c : "";
			})
			.join("\n");
		expect(flat).toContain("Error: No archive found for message does-not-exist");
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
