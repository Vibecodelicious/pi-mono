/**
 * Tests for the extension factory's wiring (Story P.1 + P.2).
 *
 * Story P.1 introduced the factory and BONSAI_GUIDANCE. Story P.2 expands
 * the factory to also register the prune tool, the `session_start` rehydrate
 * handler, and the `"context"` event handler. These tests pin the wiring
 * surface so future stories don't accidentally drop a hook.
 */

import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import factory, { BONSAI_GUIDANCE } from "../src/index.js";

describe("context-bonsai factory", () => {
	it("registers before_agent_start, session_start, and context handlers + prune tool", async () => {
		const on = vi.fn();
		const registerTool = vi.fn();
		const appendEntry = vi.fn();
		const pi = { on, registerTool, appendEntry } as unknown as ExtensionAPI;

		await factory(pi);

		const events = on.mock.calls.map((c) => c[0]);
		expect(events).toContain("before_agent_start");
		expect(events).toContain("session_start");
		expect(events).toContain("context");
		expect(registerTool).toHaveBeenCalledTimes(1);
		const tool = registerTool.mock.calls[0]?.[0] as { name: string; executionMode?: string };
		expect(tool.name).toBe("context-bonsai-prune");
		expect(tool.executionMode).toBe("sequential");
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("appends BONSAI_GUIDANCE to the existing system prompt", async () => {
		let captured: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
		const on = vi.fn((event: string, handler: unknown) => {
			if (event === "before_agent_start") {
				captured = handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
			}
		});
		const registerTool = vi.fn();
		const appendEntry = vi.fn();
		const pi = { on, registerTool, appendEntry } as unknown as ExtensionAPI;

		await factory(pi);
		expect(captured).toBeDefined();
		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "BASE",
			systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
		};
		const ctx = {} as ExtensionContext;
		const result = await captured?.(event, ctx);

		expect(result && typeof result === "object" && "systemPrompt" in result ? result.systemPrompt : undefined).toBe(
			`BASE\n\n${BONSAI_GUIDANCE}`,
		);
	});

	it("BONSAI_GUIDANCE covers the six cross-agent spec meanings", () => {
		// Cross-agent spec §1: tool existence
		expect(BONSAI_GUIDANCE).toContain("context-bonsai-prune");
		expect(BONSAI_GUIDANCE).toContain("context-bonsai-retrieve");
		// Pattern boundaries (not internal ranking disclosure)
		expect(BONSAI_GUIDANCE).toMatch(/from_pattern/);
		expect(BONSAI_GUIDANCE).toMatch(/to_pattern/);
		expect(BONSAI_GUIDANCE).toMatch(/do not output partitions or rankings/i);
		// Protected content list
		expect(BONSAI_GUIDANCE).toMatch(/Protected Context/);
		// Prioritization (older completed blocks first)
		expect(BONSAI_GUIDANCE).toMatch(/oldest completed contiguous blocks first/i);
		// Recency and drift
		expect(BONSAI_GUIDANCE).toMatch(/Recency and Drift/i);
		// Non-destructiveness + retrieval (retrieve tool reference satisfies retrieval guidance)
		expect(BONSAI_GUIDANCE).toMatch(/context-bonsai-retrieve/);
	});
});
