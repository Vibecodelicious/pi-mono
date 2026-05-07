/**
 * Integration test for Story P.4 (gauge / system-reminder injection).
 *
 * Drives a faux-provider session through 5 user prompts. Each assistant
 * response carries non-zero usage so `getContextUsage()` returns a usable
 * `tokens` value. Asserts:
 *
 * 1. The first 4 turns' "context" event sees no gauge appended to the last
 *    user message.
 * 2. The 5th turn (turnCount % GAUGE_CADENCE === 0) has a `<system-reminder>`
 *    block matching the canonical regex appended to the last user message.
 *
 * The harness captures every `Context` the faux model is called with. The
 * messages it sees are *post-transform* — i.e. after our `"context"` handler
 * has run — so any gauge injected by `maybeInjectGauge` appears here.
 */

import { type Context, fauxAssistantMessage, type Message, type TextContent, type Usage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "../harness.js";

const GAUGE_REGEX = /^<system-reminder>\n\[CONTEXT GAUGE: .* tokens \(\d+%\)\]/;

function nonZeroUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function lastUserMessageGaugeText(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const content = m.content;
		if (typeof content === "string") return undefined;
		const last = content[content.length - 1] as TextContent | undefined;
		if (last?.type !== "text") return undefined;
		return last.text.startsWith("<system-reminder>") ? last.text : undefined;
	}
	return undefined;
}

describe("context-bonsai Story P.4: 04-gauge", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("injects the gauge on turn 5 only and matches the canonical format", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);

		// Capture the post-transform Context that the faux model sees on each
		// turn. Each step's assistant response declares non-zero usage so
		// estimateContextTokens / getContextUsage produce a usable `tokens`
		// value on subsequent turns.
		let timestampCursor = 1000;
		const nextTs = () => timestampCursor++;
		const seenContexts: Context[] = [];
		const makeStep = (text: string, totalTokens: number) => (context: Context) => {
			seenContexts.push(context);
			const msg = fauxAssistantMessage(text, { timestamp: nextTs() });
			msg.usage = nonZeroUsage(totalTokens);
			return msg;
		};

		harness.setResponses([
			makeStep("turn-1 reply", 1000),
			makeStep("turn-2 reply", 2000),
			makeStep("turn-3 reply", 3000),
			makeStep("turn-4 reply", 4000),
			makeStep("turn-5 reply", 5000),
		]);

		await harness.session.prompt("user-1");
		await harness.session.prompt("user-2");
		await harness.session.prompt("user-3");
		await harness.session.prompt("user-4");
		await harness.session.prompt("user-5");

		expect(seenContexts.length).toBe(5);

		// Turns 1..4: no gauge appended.
		for (let i = 0; i < 4; i++) {
			const gauge = lastUserMessageGaugeText(seenContexts[i].messages);
			expect(gauge, `turn ${i + 1} should not carry a gauge`).toBeUndefined();
		}

		// Turn 5: gauge appended with the canonical format.
		const gaugeOnTurn5 = lastUserMessageGaugeText(seenContexts[4].messages);
		expect(gaugeOnTurn5, "turn 5 should carry a gauge").toBeDefined();
		expect(gaugeOnTurn5).toMatch(GAUGE_REGEX);
		expect(gaugeOnTurn5).toMatch(/<\/system-reminder>$/);
	});
});
