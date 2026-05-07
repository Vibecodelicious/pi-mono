/**
 * Unit tests for `ArchiveStore`. Focus on:
 * - basic get/set/clear
 * - branch-membership filter via `listActive`
 * - `hydrateFromEntries` honouring tombstone (`archive-clear`) precedence per
 *   Story P.2 AC: "Later `customType === 'context-bonsai:archive-clear'`
 *   entries (Story 3) override earlier archives for the same `anchorEntryId`."
 */

import type { CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { ArchiveStore } from "../src/archive-store.js";
import { ARCHIVE_CLEAR_CUSTOM_TYPE, ARCHIVE_CUSTOM_TYPE, type ArchiveRecord } from "../src/schema.js";

function archiveEntry(id: string, payload: ArchiveRecord, ts = 1000): CustomEntry {
	return {
		type: "custom",
		customType: ARCHIVE_CUSTOM_TYPE,
		data: payload,
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
	};
}

function clearEntry(id: string, anchorEntryId: string, ts = 2000): CustomEntry {
	return {
		type: "custom",
		customType: ARCHIVE_CLEAR_CUSTOM_TYPE,
		data: { anchorEntryId },
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
	};
}

function archive(anchor: string, end: string, summary = "s", indexTerms = ["k1"]): ArchiveRecord {
	return {
		anchorEntryId: anchor,
		anchorRole: "user",
		anchorTimestamp: 1000,
		rangeEndEntryId: end,
		rangeEndRole: "assistant",
		rangeEndTimestamp: 2000,
		summary,
		indexTerms,
		createdInTurn: 0,
	};
}

describe("ArchiveStore", () => {
	test("set/get/clear", () => {
		const store = new ArchiveStore();
		const a = archive("anchor-1", "end-1");
		store.set(a);
		expect(store.get("anchor-1")).toEqual(a);
		store.clear("anchor-1");
		expect(store.get("anchor-1")).toBeUndefined();
	});

	test("listActive filters by branch entry membership", () => {
		const store = new ArchiveStore();
		const a1 = archive("on-branch", "end-a");
		const a2 = archive("off-branch", "end-b");
		store.set(a1);
		store.set(a2);

		const active = store.listActive(new Set(["on-branch", "end-a"]));
		expect(active.map((x) => x.anchorEntryId)).toEqual(["on-branch"]);
	});

	test("hydrateFromEntries replaces in-memory state and respects tombstones", () => {
		const store = new ArchiveStore();
		// Pre-populate so we can assert hydrate clears existing state first.
		store.set(archive("ghost", "ghost-end"));

		const a1 = archive("anchor-1", "end-1", "first summary");
		const a2 = archive("anchor-2", "end-2", "second summary");

		const entries: SessionEntry[] = [
			archiveEntry("c1", a1, 1000),
			archiveEntry("c2", a2, 2000),
			clearEntry("c3", "anchor-1", 3000), // tombstone wins for anchor-1
		];

		store.hydrateFromEntries(entries);

		expect(store.get("ghost")).toBeUndefined();
		expect(store.get("anchor-1")).toBeUndefined();
		expect(store.get("anchor-2")?.summary).toBe("second summary");
	});

	test("hydrateFromEntries: re-archive after a clear restores the archive", () => {
		const store = new ArchiveStore();
		const a1 = archive("anchor-1", "end-1", "first");
		const a1Again = archive("anchor-1", "end-1", "second take");

		const entries: SessionEntry[] = [
			archiveEntry("c1", a1, 1000),
			clearEntry("c2", "anchor-1", 2000),
			archiveEntry("c3", a1Again, 3000),
		];
		store.hydrateFromEntries(entries);
		expect(store.get("anchor-1")?.summary).toBe("second take");
	});

	test("hydrateFromEntries ignores malformed payloads", () => {
		const store = new ArchiveStore();
		const entries: SessionEntry[] = [
			{
				type: "custom",
				customType: ARCHIVE_CUSTOM_TYPE,
				data: undefined,
				id: "bad1",
				parentId: null,
				timestamp: new Date(1000).toISOString(),
			},
			{
				type: "custom",
				customType: ARCHIVE_CUSTOM_TYPE,
				data: { not: "an archive" },
				id: "bad2",
				parentId: null,
				timestamp: new Date(2000).toISOString(),
			},
			archiveEntry("c1", archive("anchor-good", "end"), 3000),
		];
		store.hydrateFromEntries(entries);
		expect(store.get("anchor-good")).toBeDefined();
	});
});
