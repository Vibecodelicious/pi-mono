/**
 * Tests for the extension factory's wiring (Story P.1 + P.2 + P.3).
 *
 * Story P.1 introduced the factory and BONSAI_GUIDANCE. Story P.2 expands
 * the factory to also register the prune tool, the `session_start` rehydrate
 * handler, and the `"context"` event handler. Story P.3 adds the retrieve
 * tool registration. These tests pin the wiring surface so future stories
 * don't accidentally drop a hook.
 */

import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionEntry,
	SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import factory, { BONSAI_GUIDANCE } from "../src/index.js";

describe("context-bonsai factory", () => {
	it("registers before_agent_start, session_start, and context handlers + prune and retrieve tools", async () => {
		const on = vi.fn();
		const registerTool = vi.fn();
		const appendEntry = vi.fn();
		const pi = { on, registerTool, appendEntry } as unknown as ExtensionAPI;

		await factory(pi);

		const events = on.mock.calls.map((c) => c[0]);
		expect(events).toContain("before_agent_start");
		expect(events).toContain("session_start");
		expect(events).toContain("context");
		expect(registerTool).toHaveBeenCalledTimes(2);
		const tools = registerTool.mock.calls.map((c) => c[0] as { name: string; executionMode?: string });
		const byName = new Map(tools.map((t) => [t.name, t]));
		const pruneTool = byName.get("context-bonsai-prune");
		const retrieveTool = byName.get("context-bonsai-retrieve");
		expect(pruneTool).toBeDefined();
		expect(retrieveTool).toBeDefined();
		expect(pruneTool?.executionMode).toBe("sequential");
		expect(retrieveTool?.executionMode).toBe("sequential");
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

	it("session_start hydrates turnCount from prior user messages so gauge cadence survives a process restart", async () => {
		// Regression for Story P.5 iter 2 fix-loop, scenario E: Pi's `-p` mode
		// runs one turn per process. Without session_start hydrating turnCount
		// from the persisted user-message count, the cadence counter resets to
		// 0 on every invocation and the gauge can never reach GAUGE_CADENCE
		// (the in-memory factory closure is rebuilt on session reload, see
		// state.ts comment header).
		const handlers: Record<string, unknown> = {};
		const on = vi.fn((event: string, handler: unknown) => {
			handlers[event] = handler;
		});
		const registerTool = vi.fn();
		const appendEntry = vi.fn();
		const pi = { on, registerTool, appendEntry } as unknown as ExtensionAPI;
		await factory(pi);

		// Build a session with 4 prior user messages (count would be 4 after
		// hydration; the next context call will increment to 5 and fire).
		const userEntries: SessionEntry[] = [
			{
				id: "u1",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "u1" }], timestamp: 1 },
			},
			{
				id: "a1",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "a1" }], timestamp: 2 },
			},
			{
				id: "u2",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "u2" }], timestamp: 3 },
			},
			{
				id: "a2",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "a2" }], timestamp: 4 },
			},
			{
				id: "u3",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "u3" }], timestamp: 5 },
			},
			{
				id: "a3",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "a3" }], timestamp: 6 },
			},
			{
				id: "u4",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "u4" }], timestamp: 7 },
			},
			{
				id: "a4",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "a4" }], timestamp: 8 },
			},
		] as unknown as SessionEntry[];
		const sessionManagerStub = {
			getEntries: () => userEntries,
			getBranch: () => userEntries,
		};
		const ctxStub = {
			sessionManager: sessionManagerStub,
			getContextUsage: () => ({ tokens: 1000, contextWindow: 100000, percent: 1 }),
		} as unknown as ExtensionContext;
		const sessionStartHandler = handlers.session_start as ExtensionHandler<SessionStartEvent, void>;
		expect(sessionStartHandler).toBeDefined();
		await sessionStartHandler({ type: "session_start", reason: "reload" } as SessionStartEvent, ctxStub);

		// Now fire the context handler; turnCount goes 4 -> 5 and gauge fires.
		const contextHandler = handlers.context as ExtensionHandler<{ type: "context"; messages: unknown[] }, unknown>;
		expect(contextHandler).toBeDefined();
		const messages = [{ role: "user", content: [{ type: "text", text: "next prompt" }] }];
		const result = (await contextHandler(
			{ type: "context", messages } as { type: "context"; messages: unknown[] },
			ctxStub,
		)) as { messages?: { role: string; content: { type: string; text: string }[] }[] } | undefined;

		const out = result?.messages ?? messages;
		const last = out[out.length - 1] as { role: string; content: { type: string; text: string }[] };
		const lastTexts = (last.content as { type: string; text: string }[])
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n");
		expect(lastTexts).toMatch(/\[CONTEXT GAUGE:/);
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
