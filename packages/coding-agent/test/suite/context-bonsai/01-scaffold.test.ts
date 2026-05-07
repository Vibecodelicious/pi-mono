import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import bonsaiFactory, { BONSAI_GUIDANCE } from "../../../../context-bonsai/src/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("context-bonsai Story P.1 scaffold", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends BONSAI_GUIDANCE to the effective system prompt for the first turn", async () => {
		const harness = await createHarness({
			extensionFactories: [bonsaiFactory],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain(BONSAI_GUIDANCE.trim());
		expect(providerSystemPrompt).toContain("context-bonsai-prune");
		expect(providerSystemPrompt).toContain("context-bonsai-retrieve");
	});
});
