/**
 * Unit tests for the gauge module (Story P.4).
 *
 * Covers:
 * - `formatGaugeText` four locked severity bands and `PRUNE NOW` content.
 * - `maybeInjectGauge` cadence (every `GAUGE_CADENCE` calls).
 * - `maybeInjectGauge` no-op when usage is undefined or `tokens === null`.
 * - `maybeInjectGauge` injection into both string-form and array-form user
 *   content.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { formatGaugeText, GAUGE_CADENCE, maybeInjectGauge } from "../src/gauge.js";
import { createState } from "../src/state.js";

function userMsgString(text: string, ts = 1000): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as unknown as AgentMessage;
}

function userMsgArray(text: string, ts = 1000): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: ts,
	} as unknown as AgentMessage;
}

function assistantMsg(text: string, ts = 1000): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: ts,
	} as unknown as AgentMessage;
}

function usage(tokens: number | null, contextWindow = 100000, percent: number | null = null): ContextUsage {
	return {
		tokens,
		contextWindow,
		percent: percent ?? (tokens === null ? null : Math.round((tokens / contextWindow) * 100)),
	};
}

function getLastUserGaugeText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown };
		if (m.role !== "user") continue;
		const content = m.content as Array<{ type: string; text?: string }> | string;
		if (typeof content === "string") return undefined;
		const part = content[content.length - 1];
		if (part?.type === "text" && typeof part.text === "string" && part.text.startsWith("<system-reminder>")) {
			return part.text;
		}
		return undefined;
	}
	return undefined;
}

describe("formatGaugeText", () => {
	test("low severity (<30%) — informational, no destructive language", () => {
		const result = formatGaugeText(1000, 10000, 10);
		expect(result).toContain("[CONTEXT GAUGE: 1000 / 10000 tokens (10%)]");
		expect(result).toContain("oldest completed contiguous blocks first");
		expect(result).toContain("protect unresolved task instructions");
		expect(result).toContain("continue your work");
		expect(result).not.toContain("not destructive");
		expect(result).not.toContain("PRUNE NOW");
	});

	test("low severity at 29% boundary", () => {
		const result = formatGaugeText(2900, 10000, 29);
		expect(result).toContain("continue your work");
		expect(result).not.toContain("not destructive");
	});

	test("medium severity (30-60%) — prune-ready advisory", () => {
		const result = formatGaugeText(3000, 10000, 30);
		expect(result).toContain("[CONTEXT GAUGE: 3000 / 10000 tokens (30%)]");
		expect(result).toContain("not destructive");
		expect(result).not.toContain("significant drift requires 2 of 3 signals");
		expect(result).not.toContain("PRUNE NOW");
	});

	test("medium severity at 60% boundary", () => {
		const result = formatGaugeText(6000, 10000, 60);
		expect(result).toContain("not destructive");
		expect(result).not.toContain("significant drift requires 2 of 3 signals");
	});

	test("high severity (61-80%) — drift cues, no PRUNE NOW", () => {
		const result = formatGaugeText(6100, 10000, 61);
		expect(result).toContain("[CONTEXT GAUGE: 6100 / 10000 tokens (61%)]");
		expect(result).toContain("not destructive");
		expect(result).toContain("significant drift requires 2 of 3 signals");
		expect(result).toContain("Newest content is default keep");
		expect(result).not.toContain("PRUNE NOW");
	});

	test("high severity at 80% boundary", () => {
		const result = formatGaugeText(8000, 10000, 80);
		expect(result).toContain("significant drift requires 2 of 3 signals");
		expect(result).not.toContain("PRUNE NOW");
	});

	test("urgent severity (>80%) — explicit PRUNE NOW", () => {
		const result = formatGaugeText(8100, 10000, 81);
		expect(result).toContain("[CONTEXT GAUGE: 8100 / 10000 tokens (81%) - PRUNE NOW]");
		expect(result).toContain("Failure to prune immediately");
		expect(result).toContain("significant drift requires 2 of 3 signals");
	});

	test("urgent severity at 100%", () => {
		const result = formatGaugeText(10000, 10000, 100);
		expect(result).toContain("- PRUNE NOW]");
		expect(result).toContain("Failure to prune immediately");
	});
});

describe("maybeInjectGauge", () => {
	test("no-op on first 4 calls; fires on 5th call", () => {
		const state = createState();
		const messages = [userMsgString("hi")];
		const u = usage(1000);

		for (let i = 0; i < GAUGE_CADENCE - 1; i++) {
			const result = maybeInjectGauge(messages, state, u);
			expect(result).toBe(messages); // same reference, unchanged
			expect(getLastUserGaugeText(messages)).toBeUndefined();
		}

		const result = maybeInjectGauge(messages, state, u);
		expect(result).not.toBe(messages); // new array reference signals mutation
		const text = getLastUserGaugeText(result);
		expect(text).toBeDefined();
		expect(text).toMatch(/^<system-reminder>\n\[CONTEXT GAUGE: 1000 \/ 100000 tokens \(1%\)\]/);
		expect(text).toMatch(/<\/system-reminder>$/);
	});

	test("counter advances every call regardless of cadence", () => {
		const state = createState();
		const messages = [userMsgString("hi")];

		for (let i = 0; i < 7; i++) {
			maybeInjectGauge(messages, state, usage(1000));
		}
		expect(state.turnCount).toBe(7);
	});

	test("no-op when usage is undefined (counter still advances)", () => {
		const state = createState();
		const messages = [userMsgString("hi")];

		// Step to the 5th call — usage undefined every time.
		for (let i = 0; i < GAUGE_CADENCE; i++) {
			const r = maybeInjectGauge(messages, state, undefined);
			expect(r).toBe(messages);
		}
		expect(state.turnCount).toBe(GAUGE_CADENCE);
		expect(getLastUserGaugeText(messages)).toBeUndefined();
	});

	test("no-op when tokens === null (counter still advances)", () => {
		const state = createState();
		const messages = [userMsgString("hi")];

		for (let i = 0; i < GAUGE_CADENCE; i++) {
			const r = maybeInjectGauge(messages, state, usage(null));
			expect(r).toBe(messages);
		}
		expect(state.turnCount).toBe(GAUGE_CADENCE);
		expect(getLastUserGaugeText(messages)).toBeUndefined();
	});

	test("injects into string-form user content (normalises to array)", () => {
		const state = { turnCount: GAUGE_CADENCE - 1 } as ReturnType<typeof createState>;
		const messages: AgentMessage[] = [userMsgString("hello world", 1234)];

		const result = maybeInjectGauge(messages, state, usage(5000, 100000));

		expect(result).not.toBe(messages);
		const lastUser = result[0] as { role: string; content: Array<{ type: string; text: string }> };
		expect(Array.isArray(lastUser.content)).toBe(true);
		expect(lastUser.content).toHaveLength(2);
		expect(lastUser.content[0]).toEqual({ type: "text", text: "hello world" });
		expect(lastUser.content[1].type).toBe("text");
		expect(lastUser.content[1].text).toMatch(/^<system-reminder>/);
		// Original message must remain unmutated (we returned a new array & new
		// message object).
		expect((messages[0] as { content: unknown }).content).toBe("hello world");
	});

	test("injects into array-form user content without mutating original array", () => {
		const state = { turnCount: GAUGE_CADENCE - 1 } as ReturnType<typeof createState>;
		const original = userMsgArray("hi there");
		const originalContentRef = (original as unknown as { content: unknown[] }).content;
		const messages: AgentMessage[] = [original];

		const result = maybeInjectGauge(messages, state, usage(50000, 100000));

		expect(result).not.toBe(messages);
		const lastUser = result[0] as { content: Array<{ type: string; text: string }> };
		expect(lastUser.content).toHaveLength(2);
		expect(lastUser.content[1].text).toMatch(/^<system-reminder>/);
		// Original input array must not be mutated.
		expect(originalContentRef).toHaveLength(1);
	});

	test("appends to last user message when assistants follow earlier user", () => {
		const state = { turnCount: GAUGE_CADENCE - 1 } as ReturnType<typeof createState>;
		const messages: AgentMessage[] = [
			userMsgString("first", 100),
			assistantMsg("response", 200),
			userMsgString("second", 300),
		];

		const result = maybeInjectGauge(messages, state, usage(10000, 100000));

		expect(result).not.toBe(messages);
		const first = result[0] as { content: unknown };
		expect(first.content).toBe("first"); // untouched
		const second = result[2] as { content: Array<{ type: string; text: string }> };
		expect(Array.isArray(second.content)).toBe(true);
		expect(second.content[1].text).toMatch(/^<system-reminder>/);
	});

	test("no-op when no user messages present", () => {
		const state = { turnCount: GAUGE_CADENCE - 1 } as ReturnType<typeof createState>;
		const messages: AgentMessage[] = [assistantMsg("only assistant", 100)];

		const result = maybeInjectGauge(messages, state, usage(1000));

		expect(result).toBe(messages);
	});

	test("no-op when context window is zero or invalid", () => {
		const state = { turnCount: GAUGE_CADENCE - 1 } as ReturnType<typeof createState>;
		const messages = [userMsgString("hi")];

		const result = maybeInjectGauge(messages, state, { tokens: 100, contextWindow: 0, percent: 0 });

		expect(result).toBe(messages);
		expect(getLastUserGaugeText(messages)).toBeUndefined();
	});

	test("uses provided percent over recomputing from tokens/window", () => {
		const state = { turnCount: GAUGE_CADENCE - 1 } as ReturnType<typeof createState>;
		const messages = [userMsgString("hi")];

		const result = maybeInjectGauge(messages, state, {
			tokens: 8500,
			contextWindow: 10000,
			percent: 85,
		});

		const text = getLastUserGaugeText(result);
		expect(text).toBeDefined();
		expect(text).toContain("(85%) - PRUNE NOW]");
	});
});
