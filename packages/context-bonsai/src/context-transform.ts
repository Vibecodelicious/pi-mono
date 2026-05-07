/**
 * `"context"` event handler: rewrites outgoing `AgentMessage[]` to replace
 * archived ranges with the canonical placeholder before each LLM call.
 *
 * Correlation strategy (NON-NEGOTIABLE per Story P.2 plan):
 * - Build `branchEntryIds` from `ctx.sessionManager.getBranch()` to filter
 *   archives whose anchor is still on the branch.
 * - For each active archive, locate its anchor inside `event.messages` by
 *   `(role, timestamp)` lookup — DO NOT positional-zip with the branch.
 *   `buildSessionContext` (`session-manager.ts:376-419`) prepends a synthetic
 *   compaction-summary message, drops entries before `firstKeptEntryId`, and
 *   injects synthetics for `branch_summary` / `custom_message`, so positional
 *   zip is unsafe.
 * - If anchor or range-end can't be located in this turn's transcript,
 *   silently skip that archive (compacted away or branch switched). Keep the
 *   persisted record — it becomes active again if the branch changes back.
 *
 * Multiple archives in document order: compute `(anchorIdx, rangeEndIdx)` for
 * each archive on the unmodified array, then build a new array in one pass so
 * earlier rewrites don't shift later lookups.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ArchiveStore } from "./archive-store.js";
import type { ArchiveAnchorRole, ArchiveRecord } from "./schema.js";
import type { BonsaiState } from "./state.js";

export interface ContextEventResult {
	messages?: AgentMessage[];
}

function readRoleAndTimestamp(message: AgentMessage): { role: ArchiveAnchorRole; timestamp: number } | null {
	const m = message as { role?: unknown; timestamp?: unknown };
	if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") return null;
	if (typeof m.timestamp !== "number") return null;
	return { role: m.role, timestamp: m.timestamp };
}

function buildPlaceholderText(archive: ArchiveRecord): string {
	const indexLine = archive.indexTerms.join(", ");
	return `[PRUNED: ${archive.anchorEntryId} to ${archive.rangeEndEntryId}]\nSummary: ${archive.summary}\nIndex: ${indexLine}`;
}

/**
 * Locate the index of the first message at-or-after `startIdx` whose
 * (role, timestamp) matches.
 */
function findMessageByRoleTimestamp(
	messages: AgentMessage[],
	role: ArchiveAnchorRole,
	timestamp: number,
	startIdx: number,
): number {
	for (let i = startIdx; i < messages.length; i++) {
		const meta = readRoleAndTimestamp(messages[i]);
		if (meta && meta.role === role && meta.timestamp === timestamp) {
			return i;
		}
	}
	return -1;
}

export function createContextHandler(
	store: ArchiveStore,
	_state: BonsaiState,
): (event: ContextEvent, ctx: ExtensionContext) => Promise<ContextEventResult | undefined> {
	return async (event, ctx) => {
		// Capability gate: a stripped-down ctx without sessionManager.getBranch
		// degrades to a deterministic no-op rather than silently breaking.
		if (!ctx?.sessionManager || typeof ctx.sessionManager.getBranch !== "function") {
			return undefined;
		}

		const branch = ctx.sessionManager.getBranch();
		const branchEntryIds = new Set(branch.map((e) => e.id));
		const active = store.listActive(branchEntryIds);
		if (active.length === 0) {
			return undefined;
		}

		const messages = event.messages;

		// Resolve each archive's (anchorIdx, rangeEndIdx) up-front against the
		// unmodified array. Skip silently on miss.
		type Resolved = { archive: ArchiveRecord; anchorIdx: number; rangeEndIdx: number };
		const resolved: Resolved[] = [];
		for (const archive of active) {
			const anchorIdx = findMessageByRoleTimestamp(messages, archive.anchorRole, archive.anchorTimestamp, 0);
			if (anchorIdx === -1) continue;
			const rangeEndIdx = findMessageByRoleTimestamp(
				messages,
				archive.rangeEndRole,
				archive.rangeEndTimestamp,
				anchorIdx,
			);
			if (rangeEndIdx === -1) continue;
			resolved.push({ archive, anchorIdx, rangeEndIdx });
		}

		if (resolved.length === 0) {
			return undefined;
		}

		// Sort by anchor index so we can apply rewrites in document order
		// without index shifting (we'll rebuild a fresh array in one pass).
		resolved.sort((a, b) => a.anchorIdx - b.anchorIdx);

		// Drop overlapping archives (defensive — validation should reject
		// these on creation, but a later compaction could in theory leave
		// pathological state). When two ranges overlap, keep the earlier-
		// indexed one and drop the later.
		const accepted: Resolved[] = [];
		let lastEnd = -1;
		for (const r of resolved) {
			if (r.anchorIdx <= lastEnd) continue;
			accepted.push(r);
			lastEnd = r.rangeEndIdx;
		}

		// Build the rewritten transcript in a single pass.
		const out: AgentMessage[] = [];
		let i = 0;
		let cursor = 0;
		while (i < messages.length) {
			if (cursor < accepted.length && i === accepted[cursor].anchorIdx) {
				const r = accepted[cursor];
				const original = messages[r.anchorIdx];
				const originalTimestamp =
					typeof (original as { timestamp?: unknown }).timestamp === "number"
						? (original as { timestamp: number }).timestamp
						: r.archive.anchorTimestamp;
				const placeholderMessage = {
					role: "user",
					content: [{ type: "text", text: buildPlaceholderText(r.archive) }],
					timestamp: originalTimestamp,
				} as unknown as AgentMessage;
				out.push(placeholderMessage);
				// Skip followers up to and including range-end.
				i = r.rangeEndIdx + 1;
				cursor++;
				continue;
			}
			out.push(messages[i]);
			i++;
		}

		return { messages: out };
	};
}
