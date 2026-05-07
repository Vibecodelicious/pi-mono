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
		store.hydrateFromEntries(ctx.sessionManager.getEntries());
	});

	pi.registerTool(createPruneTool(pi, store, state));
	pi.registerTool(createRetrieveTool(pi, store));

	pi.on("context", createContextHandler(store, state));
};

export default factory;
