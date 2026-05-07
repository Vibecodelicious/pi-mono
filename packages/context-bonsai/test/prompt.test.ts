import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import factory, { BONSAI_GUIDANCE } from "../src/index.js";

describe("context-bonsai factory (Story P.1)", () => {
	it("registers exactly one before_agent_start handler and no other handlers", async () => {
		const on = vi.fn();
		const registerTool = vi.fn();
		const appendEntry = vi.fn();
		const pi = { on, registerTool, appendEntry } as unknown as ExtensionAPI;

		await factory(pi);

		expect(on).toHaveBeenCalledTimes(1);
		expect(on.mock.calls[0]?.[0]).toBe("before_agent_start");
		expect(typeof on.mock.calls[0]?.[1]).toBe("function");
		expect(registerTool).not.toHaveBeenCalled();
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("appends BONSAI_GUIDANCE to the existing system prompt", async () => {
		let captured: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
		const on = vi.fn((_event: string, handler: unknown) => {
			captured = handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
		});
		const pi = { on } as unknown as ExtensionAPI;

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
