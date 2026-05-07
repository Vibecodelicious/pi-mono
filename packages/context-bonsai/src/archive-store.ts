/**
 * In-memory archive store keyed by `anchorEntryId`.
 *
 * Why a separate store (and not message-metadata, OpenCode's approach)?
 * The shared spec's "Pi-context-bonsai-spec" §"Design Implications" calls
 * this out: pi-ai `Message` has no id field, so we cannot stash archive
 * metadata on the wire-message object itself. The store sits next to
 * outgoing messages, not on them, and is rehydrated from custom session
 * entries on `session_start`.
 *
 * Tombstone semantics: when Story 3 writes
 * `context-bonsai:archive-clear { anchorEntryId }` entries, hydrate must
 * honour their precedence — the LAST-written entry per `anchorEntryId`
 * wins, regardless of whether it's an archive or a clear. This makes
 * same-turn prune+retrieve deterministic: prune appends archive,
 * retrieve appends archive-clear, hydrate sees clear last → no archive.
 */

import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	ARCHIVE_CLEAR_CUSTOM_TYPE,
	ARCHIVE_CUSTOM_TYPE,
	type ArchiveClearRecord,
	type ArchiveRecord,
} from "./schema.js";

export class ArchiveStore {
	private archives = new Map<string, ArchiveRecord>();

	get(anchorEntryId: string): ArchiveRecord | undefined {
		return this.archives.get(anchorEntryId);
	}

	set(archive: ArchiveRecord): void {
		this.archives.set(archive.anchorEntryId, archive);
	}

	clear(anchorEntryId: string): void {
		this.archives.delete(anchorEntryId);
	}

	/** All currently-active archives whose anchor is still on the supplied branch. */
	listActive(branchEntryIds: Set<string>): ArchiveRecord[] {
		const out: ArchiveRecord[] = [];
		for (const archive of this.archives.values()) {
			if (branchEntryIds.has(archive.anchorEntryId)) {
				out.push(archive);
			}
		}
		return out;
	}

	/**
	 * Replace in-memory state by re-scanning persisted entries in
	 * append order. Last write per `anchorEntryId` wins; tombstones override
	 * earlier archives.
	 */
	hydrateFromEntries(entries: SessionEntry[]): void {
		this.archives.clear();
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === ARCHIVE_CUSTOM_TYPE) {
				const data = entry.data as ArchiveRecord | undefined;
				if (!data || typeof data.anchorEntryId !== "string") continue;
				this.archives.set(data.anchorEntryId, data);
			} else if (entry.customType === ARCHIVE_CLEAR_CUSTOM_TYPE) {
				const data = entry.data as ArchiveClearRecord | undefined;
				if (!data || typeof data.anchorEntryId !== "string") continue;
				this.archives.delete(data.anchorEntryId);
			}
		}
	}
}
