/**
 * Shared-spec sensitive-content prune oracle (Story P.2).
 *
 * Seeds a unique secret nonce inside a message range, prunes that range with
 * a summary/index that intentionally do NOT contain the nonce, then asserts
 * the next model-visible transcript no longer carries the nonce in any form
 * (text part, tool input, or tool output) — only the placeholder remains.
 *
 * The prune-tool's success-text echoes `from_pattern` / `to_pattern` /
 * `summary` / `index_terms`, so we choose those carefully so nothing in the
 * success-text can leak the nonce. The toolResult message of the prune call
 * itself is allowed to remain in context (it's outside the archive range).
 */

import { type Context, fauxAssistantMessage, fauxToolCall, type Message } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "./sdk-harness.js";

const SECRET_NONCE = "S3CR3T-W4LRUS-9X7";

describe("context-bonsai Story P.2: 02c-prune-secret-oracle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("post-prune transcript does not contain the secret nonce", async () => {
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
				return fauxAssistantMessage("intro-block", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				// The secret nonce lives inside this assistant block.
				return fauxAssistantMessage(`anchor-block: leaked secret is ${SECRET_NONCE}`, {
					timestamp: nextTs(),
				});
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("range-end-block", { timestamp: nextTs() });
			},
			(context) => {
				seenContexts.push(context);
				// Prune patterns + summary + index_terms are intentionally
				// chosen so they do NOT contain the nonce.
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context-bonsai-prune",
							{
								from_pattern: "anchor-block",
								to_pattern: "range-end-block",
								summary: "anchor through range-end",
								index_terms: ["anchor", "range-end"],
							},
							{ id: "tc-prune-secret" },
						),
					],
					{ stopReason: "toolUse", timestamp: nextTs() },
				);
			},
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("post-prune ack", { timestamp: nextTs() });
			},
		]);

		await harness.session.prompt("p1");
		await harness.session.prompt("p2");
		await harness.session.prompt("p3");
		await harness.session.prompt("p4-prune");

		// The 5th captured Context (the assistant turn AFTER the prune
		// resolved) is the one we audit.
		const post = seenContexts[seenContexts.length - 1];
		const transcript = JSON.stringify(post.messages);

		// The placeholder must be present...
		expect(transcript).toMatch(/\[PRUNED: \\?"?\S+ to \S+\]/);
		// ...but the nonce must not survive anywhere — not in text, not in
		// tool inputs, not in tool outputs.
		expect(transcript).not.toContain(SECRET_NONCE);

		// Belt-and-braces: walk every message and explicitly inspect text +
		// tool-call inputs + tool-result content for the nonce.
		for (const m of post.messages) {
			expect(textForMessage(m)).not.toContain(SECRET_NONCE);
		}
	});
});

function textForMessage(m: Message): string {
	if (typeof m.content === "string") return m.content;
	const parts = m.content as Array<{
		type: string;
		text?: string;
		name?: string;
		arguments?: unknown;
	}>;
	const buf: string[] = [];
	for (const p of parts) {
		if (p.type === "text" && typeof p.text === "string") buf.push(p.text);
		else if (p.type === "toolCall") buf.push(`${p.name ?? ""}:${JSON.stringify(p.arguments ?? null)}`);
		else if (p.type === "image") buf.push("[image]");
	}
	return buf.join("\n");
}
