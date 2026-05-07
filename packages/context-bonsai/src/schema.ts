/**
 * Archive record schema (Pi).
 *
 * Pi cannot rely on a stable wire-message id (LLM messages carry no id, only
 * `(role, timestamp)`), so the archive record persists BOTH the durable
 * `SessionEntry.id` for branch-membership reasoning AND the `(role,
 * timestamp)` pair for `event.messages` re-correlation in the `"context"`
 * transform.
 *
 * Persistence: written via `pi.appendEntry("context-bonsai:archive", record)`
 * which becomes a `CustomEntry { type: "custom", customType: "context-bonsai:archive", data: ArchiveRecord }`
 * on the session file. Story 3 will write tombstones with
 * `customType === "context-bonsai:archive-clear"`.
 */

export type ArchiveAnchorRole = "user" | "assistant" | "toolResult";

export interface ArchiveRecord {
	/** SessionEntry.id of the anchor message (the first message in the archived range). */
	anchorEntryId: string;
	/** Role of the anchor's wire message (`message.role`). */
	anchorRole: ArchiveAnchorRole;
	/** Wire-message timestamp (numeric, from pi-ai `Message.timestamp`). */
	anchorTimestamp: number;
	/** SessionEntry.id of the range-end message (last message inclusive). */
	rangeEndEntryId: string;
	rangeEndRole: ArchiveAnchorRole;
	rangeEndTimestamp: number;
	/** Model-supplied 1-3 sentence summary, non-empty after trim. */
	summary: string;
	/** Model-supplied 3-8 retrieval keywords, non-empty after trim. */
	indexTerms: string[];
	/** Optional reason from the model. */
	reason?: string;
	/** Sequential turn counter at archive creation; informational. */
	createdInTurn: number;
}

/** Tombstone payload written by Story 3's retrieve tool. */
export interface ArchiveClearRecord {
	/** SessionEntry.id of the anchor that should be considered un-archived. */
	anchorEntryId: string;
}

export const ARCHIVE_CUSTOM_TYPE = "context-bonsai:archive";
export const ARCHIVE_CLEAR_CUSTOM_TYPE = "context-bonsai:archive-clear";
