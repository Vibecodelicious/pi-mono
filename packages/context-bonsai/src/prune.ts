/**
 * `context-bonsai-prune` tool factory.
 *
 * The tool resolves `from_pattern` / `to_pattern` against the current branch's
 * `SessionMessageEntry[]`, validates the resulting range, persists an
 * `ArchiveRecord` via `pi.appendEntry`, and returns the OpenCode-shaped
 * success string. Failures are returned as plain-text content (NOT thrown) so
 * the model receives a deterministic, actionable error and can retry.
 *
 * Invariants (from the story plan + shared spec):
 * - `executionMode: "sequential"` so two parallel `context-bonsai-prune` calls
 *   in one assistant message can't race the `pi.appendEntry` write. This is
 *   the only same-turn race that's real in Pi (`packages/agent/src/types.ts`
 *   defaults to `"parallel"`).
 * - Persists archive with `(role, timestamp)` for both anchor and range-end.
 *   Story 2 §"Design Implications": `(role, timestamp)` is the only stable
 *   identifier shared between the session file and the outgoing transcript
 *   (since `buildSessionContext` injects synthetics + drops entries before
 *   `firstKeptEntryId`).
 * - No `setIdVisibility` call (Pi's placeholder carries the id literally).
 * - No same-step prune set (Pi intentionally does not port that guard).
 * - Fail-closed: if `ctx.sessionManager.getBranch` or `pi.appendEntry` is
 *   unavailable, return a plain-text compatibility error rather than
 *   silently no-op.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionMessageEntry,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ArchiveStore } from "./archive-store.js";
import { filterMessageEntries, resolvePatternBoundary } from "./prune-pattern.js";
import { ARCHIVE_CUSTOM_TYPE, type ArchiveAnchorRole, type ArchiveRecord } from "./schema.js";
import type { BonsaiState } from "./state.js";

const pruneSchema = Type.Object(
	{
		from_pattern: Type.String({
			description: "Pattern used to resolve the start of one contiguous block to archive",
		}),
		to_pattern: Type.String({
			description: "Pattern used to resolve the end of one contiguous block to archive",
		}),
		summary: Type.String({
			description: "Concise summary (1-3 sentences) of the archived content",
		}),
		index_terms: Type.Array(Type.String(), {
			description: "Keywords for retrieval, 3-8 terms",
		}),
		reason: Type.Optional(Type.String({ description: "Reason for archiving this range" })),
	},
	{ additionalProperties: false },
);

export type PruneToolInput = Static<typeof pruneSchema>;

const PRUNE_DESCRIPTION =
	"Archive one contiguous range of conversation messages with a summary using pattern boundaries. Use this in a single turn after internal ranking; do not output partitions or rankings before prune execution.";

function plainTextResult(text: string): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
} {
	return { content: [{ type: "text", text }], details: undefined };
}

interface MessageWithTimestamp {
	role: ArchiveAnchorRole;
	timestamp: number;
}

function readMessageRoleAndTimestamp(entry: SessionMessageEntry): MessageWithTimestamp | null {
	const message = entry.message as { role?: unknown; timestamp?: unknown };
	const role = message.role;
	const timestamp = message.timestamp;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") {
		return null;
	}
	if (typeof timestamp !== "number") {
		return null;
	}
	return { role, timestamp };
}

/**
 * Validate a candidate range over the filtered message entries:
 * - from precedes to in entry order
 * - neither boundary sits inside an already-pruned (active) range
 * - no `assistant`/`toolResult` pair is split across the range boundary
 *   (every assistant `toolCall` inside the range must have its matching
 *   `toolResult` also inside, AND every `toolResult` inside the range must
 *   have its originating `toolCall` also inside). Both directions matter
 *   because the cross-agent spec MUST ("range MUST NOT cut through
 *   incomplete tool-call history") is direction-agnostic — a toolResult
 *   inside the range whose toolCall lives in an assistant entry BEFORE the
 *   range is exactly such a cut, and would leave the assistant's toolCall
 *   visible to the model with no matching result.
 */
function validateRange(
	messageEntries: SessionMessageEntry[],
	fromIdx: number,
	toIdx: number,
	store: ArchiveStore,
): string | null {
	if (fromIdx > toIdx) {
		return "from_pattern must resolve to a message that precedes to_pattern chronologically";
	}

	// Build the set of entry ids inside any active archive range so we can
	// detect overlap. We compute one time per validation call.
	const branchIds = new Set(messageEntries.map((e) => e.id));
	const archives = store.listActive(branchIds);
	const archivedIds = new Set<string>();
	for (const archive of archives) {
		const a = messageEntries.findIndex((e) => e.id === archive.anchorEntryId);
		const b = messageEntries.findIndex((e) => e.id === archive.rangeEndEntryId);
		if (a === -1 || b === -1) continue;
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);
		for (let i = lo; i <= hi; i++) {
			archivedIds.add(messageEntries[i].id);
		}
	}

	if (archivedIds.has(messageEntries[fromIdx].id)) {
		return `from_pattern resolved to a message that falls within an already-pruned range`;
	}
	if (archivedIds.has(messageEntries[toIdx].id)) {
		return `to_pattern resolved to a message that falls within an already-pruned range`;
	}

	// Tool-call completeness: collect ids of toolCalls that originate inside
	// the range and assert their matching toolResult is also inside.
	const callIdsInRange = new Set<string>();
	for (let i = fromIdx; i <= toIdx; i++) {
		const message = messageEntries[i].message as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as Array<{ type?: string; id?: unknown }>) {
			if (part?.type === "toolCall" && typeof part.id === "string") {
				callIdsInRange.add(part.id);
			}
		}
	}
	const resultsInRange = new Set<string>();
	for (let i = fromIdx; i <= toIdx; i++) {
		const message = messageEntries[i].message as { role?: string; toolCallId?: unknown };
		if (message.role !== "toolResult") continue;
		if (typeof message.toolCallId === "string") {
			resultsInRange.add(message.toolCallId);
		}
	}
	for (const callId of callIdsInRange) {
		if (!resultsInRange.has(callId)) {
			return `range cuts through an incomplete tool call (callId=${callId}); choose boundaries that keep matching toolCall and toolResult together`;
		}
	}
	// Reverse direction: every toolResult inside the range must have its
	// originating toolCall also inside. If the toolCall is in an assistant
	// entry BEFORE the range, archiving the toolResult would orphan the
	// model-visible toolCall (visible call, hidden result) — which is exactly
	// the directional-agnostic cut the spec MUST prevents.
	for (const resultCallId of resultsInRange) {
		if (!callIdsInRange.has(resultCallId)) {
			return `range cuts through an incomplete tool call (orphan toolResult callId=${resultCallId}); from_pattern must include the originating toolCall`;
		}
	}

	return null;
}

export function createPruneTool(pi: ExtensionAPI, store: ArchiveStore, state: BonsaiState): ToolDefinition {
	return defineTool({
		name: "context-bonsai-prune",
		label: "context-bonsai-prune",
		description: PRUNE_DESCRIPTION,
		parameters: pruneSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			// Capability gate: in a stripped-down ctx (test stubs, future API
			// drift) the required primitives may be missing. Return a
			// deterministic compatibility error rather than silently
			// succeeding.
			if (!ctx?.sessionManager || typeof ctx.sessionManager.getBranch !== "function") {
				return plainTextResult(
					"context-bonsai-prune: ctx.sessionManager.getBranch is unavailable in this Pi runtime; cannot prune.",
				);
			}
			if (typeof pi.appendEntry !== "function") {
				return plainTextResult(
					"context-bonsai-prune: pi.appendEntry is unavailable in this Pi runtime; cannot persist archive.",
				);
			}

			const fromPattern = params.from_pattern;
			const toPattern = params.to_pattern;
			const summary = params.summary;
			const indexTerms = params.index_terms;
			const reason = params.reason;

			if (typeof fromPattern !== "string" || typeof toPattern !== "string") {
				return plainTextResult("Pattern mode requires both from_pattern and to_pattern.");
			}
			if (typeof summary !== "string" || summary.trim() === "") {
				return plainTextResult("summary cannot be empty");
			}
			if (!Array.isArray(indexTerms) || indexTerms.length === 0) {
				return plainTextResult("index_terms cannot be empty");
			}
			const trimmedIndexTerms = indexTerms.map((t) => (typeof t === "string" ? t.trim() : ""));
			if (trimmedIndexTerms.some((t) => t.length === 0)) {
				return plainTextResult("index_terms entries must be non-empty after trim");
			}

			const branch = ctx.sessionManager.getBranch();
			const messageEntries = filterMessageEntries(branch);

			let fromEntryId: string;
			let toEntryId: string;
			try {
				fromEntryId = resolvePatternBoundary(messageEntries, fromPattern);
			} catch (err) {
				return plainTextResult(err instanceof Error ? err.message : String(err));
			}
			try {
				toEntryId = resolvePatternBoundary(messageEntries, toPattern);
			} catch (err) {
				return plainTextResult(err instanceof Error ? err.message : String(err));
			}

			const fromIdx = messageEntries.findIndex((e) => e.id === fromEntryId);
			const toIdx = messageEntries.findIndex((e) => e.id === toEntryId);

			const validationError = validateRange(messageEntries, fromIdx, toIdx, store);
			if (validationError) {
				return plainTextResult(`Validation error: ${validationError}`);
			}

			const fromMeta = readMessageRoleAndTimestamp(messageEntries[fromIdx]);
			const toMeta = readMessageRoleAndTimestamp(messageEntries[toIdx]);
			if (!fromMeta || !toMeta) {
				return plainTextResult(
					"Validation error: anchor or range-end message lacks a numeric timestamp; cannot persist archive correlation",
				);
			}

			const archive: ArchiveRecord = {
				anchorEntryId: fromEntryId,
				anchorRole: fromMeta.role,
				anchorTimestamp: fromMeta.timestamp,
				rangeEndEntryId: toEntryId,
				rangeEndRole: toMeta.role,
				rangeEndTimestamp: toMeta.timestamp,
				summary,
				indexTerms: trimmedIndexTerms,
				reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
				createdInTurn: state.turnCount,
			};

			try {
				pi.appendEntry(ARCHIVE_CUSTOM_TYPE, archive);
			} catch (err) {
				return plainTextResult(
					`context-bonsai-prune: failed to persist archive: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			store.set(archive);

			const rangeSize = toIdx - fromIdx + 1;
			const successText = `Archived ${rangeSize} messages from pattern "${fromPattern}" (resolved to ${fromEntryId}) to pattern "${toPattern}" (resolved to ${toEntryId}).\nSummary: ${summary}\nIndex terms: ${trimmedIndexTerms.join(", ")}`;

			return plainTextResult(successText);
		},
	});
}
