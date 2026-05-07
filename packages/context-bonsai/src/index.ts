import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ArchiveStore } from "./archive-store.js";
import { createContextHandler } from "./context-transform.js";
import { BONSAI_GUIDANCE } from "./prompt.js";
import { createPruneTool } from "./prune.js";
import { createRetrieveTool } from "./retrieve.js";
import { createState } from "./state.js";

export { ArchiveStore } from "./archive-store.js";
export { createContextHandler } from "./context-transform.js";
export { BONSAI_GUIDANCE } from "./prompt.js";
export { createPruneTool } from "./prune.js";
export { createRetrieveTool } from "./retrieve.js";
export {
	ARCHIVE_CLEAR_CUSTOM_TYPE,
	ARCHIVE_CUSTOM_TYPE,
	type ArchiveAnchorRole,
	type ArchiveClearRecord,
	type ArchiveRecord,
} from "./schema.js";
export { type BonsaiState, createState } from "./state.js";

const factory: ExtensionFactory = (pi) => {
	const store = new ArchiveStore();
	const state = createState();

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${BONSAI_GUIDANCE}`,
	}));

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		store.hydrateFromEntries(entries);
		// Hydrate turnCount from the session so gauge cadence is stable across
		// process restarts (Pi's `-p` mode runs one turn per process; without
		// hydration, turnCount would reset to 0 each invocation and the gauge
		// would never reach the cadence threshold). Count user messages — each
		// user message marks the start of one LLM-call turn.
		let userMessageCount = 0;
		for (const entry of entries) {
			if (entry.type === "message" && entry.message?.role === "user") {
				userMessageCount += 1;
			}
		}
		state.turnCount = userMessageCount;
	});

	pi.registerTool(createPruneTool(pi, store, state));
	pi.registerTool(createRetrieveTool(pi, store));

	pi.on("context", createContextHandler(store, state));
};

export default factory;
