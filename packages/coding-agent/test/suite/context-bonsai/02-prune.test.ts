/**
 * Integration test for Story P.2.
 *
 * Sets up a faux-provider session with a small mixed transcript, makes the
 * model call `context-bonsai-prune`, then asserts:
 * (1) the next LLM call sees a transcript with the canonical placeholder in
 *     the anchor's position and the follower range elided.
 * (2) reload (re-instantiate `SessionManager` from the same session file +
 *     re-emit `session_start`) reproduces the same transform output.
 */

import { type Context, fauxAssistantMessage, fauxToolCall, type Message } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("context-bonsai Story P.2: 02-prune", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("prunes a contiguous range and elides followers in the next LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["context-bonsai-prune"]);

		// Seed a scripted assistant transcript across multiple turns. After
		// the first user prompt we let the assistant emit four assistant
		// messages plus follow-up content that we'll later prune.

		// Capture every Context the faux model is called with so we can assert
		// what the post-transform messages look like on each call.
		// Each faux response is given a unique numeric timestamp so the
		// `(role, timestamp)` correlation in the context transform is
		// deterministic — `Date.now()` is millisecond-resolution and can
		// collide across rapid in-process calls.
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
				return fauxAssistantMessage("second assistant block", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("third assistant block (target)", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("fourth assistant block (target end)", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context-bonsai-prune",
							{
								from_pattern: "third assistant block (target)",
								to_pattern: "fourth assistant block (target end)",
								summary: "third and fourth blocks",
								index_terms: ["target", "block-3-4"],
							},
							{ id: "tc-prune" },
						),
					],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-prune assistant says ok", { timestamp: nextTs() });
			},
		]);

		await harness.session.prompt("user-1: setup");
		await harness.session.prompt("user-2: more");
		await harness.session.prompt("user-3: ask third");
		await harness.session.prompt("user-4: ask fourth");
		await harness.session.prompt("user-5: do prune");

		// The 6th model call (after prune) is the one whose context we care
		// about: it must see a placeholder where the third+fourth assistant
		// blocks used to be.
		expect(seenContexts.length).toBeGreaterThanOrEqual(6);
		const postPruneContext = seenContexts[seenContexts.length - 1];
		const transcriptText = postPruneContext.messages.map((m) => messageText(m)).join("\n---\n");

		expect(transcriptText).toMatch(
			/\[PRUNED: \S+ to \S+\]\nSummary: third and fourth blocks\nIndex: target, block-3-4/,
		);
		// Elided followers: the second assistant block remains; the third + fourth do not.
		expect(transcriptText).toMatch(/assistant:first assistant block/);
		expect(transcriptText).toMatch(/assistant:second assistant block/);
		// Assert the third + fourth assistant blocks no longer appear at the
		// `assistant:` prefix (they're inside the placeholder range). They may
		// still echo inside the prune toolResult success-text — that's fine.
		expect(transcriptText).not.toMatch(/assistant:third assistant block \(target\)/);
		expect(transcriptText).not.toMatch(/assistant:fourth assistant block \(target end\)/);
	});

	it("the prune persists in the session and reload reproduces the same placeholder", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["context-bonsai-prune"]);

		let timestampCursor = 1000;
		const nextTs = () => timestampCursor++;
		const seenContexts: Context[] = [];
		harness.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("a1", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("a2-target-start", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("a3-target-end", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context-bonsai-prune",
							{
								from_pattern: "a2-target-start",
								to_pattern: "a3-target-end",
								summary: "archived a2..a3",
								index_terms: ["a2", "a3"],
							},
							{ id: "tc-prune-2" },
						),
					],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-archive assistant", { timestamp: nextTs() });
			},
		]);

		await harness.session.prompt("u1");
		await harness.session.prompt("u2");
		await harness.session.prompt("u3");
		await harness.session.prompt("u4-prune");

		// Confirm archive entry was persisted to the session.
		const archiveEntries = harness.sessionManager
			.getEntries()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === "context-bonsai:archive",
			);
		expect(archiveEntries).toHaveLength(1);

		// Reload the session in-place (extension session_start hydrate path).
		await harness.session.reload();

		// Issue another turn and check the reloaded transcript still has the
		// placeholder.
		harness.appendResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-reload assistant", { timestamp: nextTs() });
			},
		]);
		await harness.session.prompt("u5-after-reload");

		const lastContext = seenContexts[seenContexts.length - 1];
		const transcriptText = lastContext.messages.map((m) => messageText(m)).join("\n---\n");
		expect(transcriptText).toMatch(/\[PRUNED: \S+ to \S+\]\nSummary: archived a2\.\.a3\nIndex: a2, a3/);
		// The original assistant `a2-target-start` and `a3-target-end` blocks
		// must not appear at the assistant role anymore (they've been
		// elided / replaced). The pattern strings still appear in the
		// toolResult success-text, which is fine.
		expect(transcriptText).not.toMatch(/assistant:a2-target-start/);
		expect(transcriptText).not.toMatch(/assistant:a3-target-end/);
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
