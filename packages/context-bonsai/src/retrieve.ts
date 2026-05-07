/**
 * `context-bonsai-retrieve` tool factory.
 *
 * The tool clears a previously-written archive so the next `"context"` event
 * no longer elides that range. Persistence is via a tombstone custom entry
 * (`customType: "context-bonsai:archive-clear"`) so a reload still reflects
 * the retrieval.
 *
 * Invariants (from the story plan + shared spec):
 * - `executionMode: "sequential"` for parity with prune. Two parallel
 *   `context-bonsai-retrieve` calls against the same anchor cannot race
 *   each other's "archive exists?" check.
 * - **No same-step guard** (intentional Pi simplification). Same-turn
 *   prune+retrieve is supported as an audit-clean no-op via tombstone-wins
 *   hydration already implemented in `archive-store.ts`. Pi does NOT port
 *   OpenCode's `sameStepPrunes` machinery.
 * - Persistence: writes a `context-bonsai:archive-clear` custom entry via
 *   `pi.appendEntry`. No atomic-update wrapper — `pi.appendEntry` ->
 *   `appendFileSync` is the atomic primitive.
 * - In-memory store update: removes the archive from the in-memory map
 *   via `ArchiveStore.clear(anchorEntryId)`.
 * - Fail-closed: if `pi.appendEntry` is unavailable, return a deterministic
 *   plain-text compatibility error and do not mutate archive state.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ArchiveStore } from "./archive-store.js";
import { ARCHIVE_CLEAR_CUSTOM_TYPE, type ArchiveClearRecord } from "./schema.js";

const retrieveSchema = Type.Object(
	{
		anchor_id: Type.String({
			description: "The ID of the anchor message to restore",
		}),
	},
	{ additionalProperties: false },
);

export type RetrieveToolInput = Static<typeof retrieveSchema>;

const RETRIEVE_DESCRIPTION =
	"Restore previously pruned conversation content by clearing archive metadata from the anchor message";

function plainTextResult(text: string): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
} {
	return { content: [{ type: "text", text }], details: undefined };
}

export function createRetrieveTool(pi: ExtensionAPI, store: ArchiveStore): ToolDefinition {
	return defineTool({
		name: "context-bonsai-retrieve",
		label: "context-bonsai-retrieve",
		description: RETRIEVE_DESCRIPTION,
		parameters: retrieveSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			// Capability gate: appendEntry is the atomic primitive for
			// persisting the tombstone. If it's missing, fail closed without
			// mutating in-memory state.
			if (typeof pi.appendEntry !== "function") {
				return plainTextResult(
					"context-bonsai-retrieve: pi.appendEntry is unavailable in this Pi runtime; cannot persist tombstone.",
				);
			}

			const anchorId = params.anchor_id;
			if (typeof anchorId !== "string" || anchorId.length === 0) {
				return plainTextResult("context-bonsai-retrieve: anchor_id must be a non-empty string");
			}

			const archive = store.get(anchorId);
			if (!archive) {
				return plainTextResult(`Error: No archive found for message ${anchorId}`);
			}

			// Compute message count via the current branch when sessionManager
			// is available. If the branch is unreachable (capability-stripped
			// ctx) we still proceed — the tombstone write is the load-bearing
			// behaviour; the count is informational. Anchor and range-end
			// inclusive when both are on the branch; fall back to a minimum of
			// 1 (anchor === rangeEnd) or 2 (different ids) when we cannot
			// resolve indices.
			let messageCount: number;
			if (ctx?.sessionManager && typeof ctx.sessionManager.getBranch === "function") {
				const branch = ctx.sessionManager.getBranch();
				const anchorIdx = branch.findIndex((e) => e.id === archive.anchorEntryId);
				const rangeEndIdx = branch.findIndex((e) => e.id === archive.rangeEndEntryId);
				if (anchorIdx !== -1 && rangeEndIdx !== -1) {
					const lo = Math.min(anchorIdx, rangeEndIdx);
					const hi = Math.max(anchorIdx, rangeEndIdx);
					messageCount = hi - lo + 1;
				} else {
					messageCount = archive.anchorEntryId === archive.rangeEndEntryId ? 1 : 2;
				}
			} else {
				messageCount = archive.anchorEntryId === archive.rangeEndEntryId ? 1 : 2;
			}

			const tombstone: ArchiveClearRecord = { anchorEntryId: anchorId };
			try {
				pi.appendEntry(ARCHIVE_CLEAR_CUSTOM_TYPE, tombstone);
			} catch (err) {
				return plainTextResult(
					`context-bonsai-retrieve: failed to persist tombstone: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			store.clear(anchorId);

			return plainTextResult(
				`Restored ${messageCount} messages from range ${archive.anchorEntryId} to ${archive.rangeEndEntryId}. Original content is now visible.`,
			);
		},
	});
}
