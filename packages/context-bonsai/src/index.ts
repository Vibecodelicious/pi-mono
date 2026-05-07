import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { BONSAI_GUIDANCE } from "./prompt.js";

export { BONSAI_GUIDANCE } from "./prompt.js";

const factory: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${BONSAI_GUIDANCE}`,
	}));
};

export default factory;
