/**
 * Pi-side adapter that builds a search corpus over a Pi `SessionMessageEntry`
 * (the `entry.message` is a pi-ai `Message`: `UserMessage | AssistantMessage |
 * ToolResultMessage`) and resolves a pattern to a single anchor entry id using
 * the OpenCode-derived heuristic chain in `prune-pattern-matcher.ts`.
 *
 * Spec ties:
 * - Pattern Matching Contract bullet 1 (MUST): the corpus MUST contain message
 *   text PLUS completed tool-call NAMES, INPUTS, AND OUTPUTS. Plain-text-only
 *   would be a spec violation, so we walk the assistant `toolCall` parts and
 *   the corresponding `toolResult` messages to emit `tool:`, `input:`, and
 *   `output:` segments.
 * - Pattern Matching Contract prune-wrapper filter (MUST): on ambiguity,
 *   exclude prior `context-bonsai-prune` tool-call wrappers (assistant or
 *   toolResult) before returning the deterministic ambiguity error.
 *   This stops a failed-prune retry from self-poisoning when the failed call's
 *   echoed `from_pattern`/`to_pattern` text matches alongside the real target.
 *
 * Note on tool wiring: in Pi, an assistant message's `toolCall` part carries
 * the input arguments, and the matching `ToolResultMessage` (a separate entry
 * with the same `toolCallId`) carries the output. The OpenCode reference
 * stores both on a single message via `parts`, so we have to bridge them by
 * `toolCallId` here.
 */

import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

const CORPUS_PART_DELIMITER = "\n<bonsai-part>\n";
const PRUNE_TOOL_NAME = "context-bonsai-prune";

function normalizeForStableJson(value: unknown): unknown {
	if (value === null) {
		return null;
	}

	const valueType = typeof value;

	if (valueType === "bigint") {
		return String(value);
	}

	if (valueType === "string" || valueType === "number" || valueType === "boolean") {
		return value;
	}

	if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
		return undefined;
	}

	if (Array.isArray(value)) {
		return value.map((item) => {
			const normalized = normalizeForStableJson(item);
			return normalized === undefined ? null : normalized;
		});
	}

	const candidate = value as { toJSON?: () => unknown };
	if (typeof candidate.toJSON === "function") {
		return normalizeForStableJson(candidate.toJSON());
	}

	const sortedEntries = Object.keys(value as Record<string, unknown>)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((key) => {
			const normalized = normalizeForStableJson((value as Record<string, unknown>)[key]);
			return [key, normalized] as const;
		})
		.filter(([, normalized]) => normalized !== undefined);

	return Object.fromEntries(sortedEntries);
}

export function stableSerialize(value: unknown): string {
	const normalized = normalizeForStableJson(value);
	const serialized = JSON.stringify(normalized);
	return serialized === undefined ? "null" : serialized;
}

/**
 * Build a flat string corpus for a single message entry. Includes:
 * - normal text content (for user / assistant / toolResult roles)
 * - completed assistant tool-call name + stable-serialized input arguments
 * - resolved tool-result tool name + stable-serialized output content
 *
 * `toolResultsByCallId` maps `toolCallId -> ToolResultMessage` so that an
 * assistant message's emitted tool corpus can include the corresponding
 * output.
 */
export function buildMessageSearchCorpus(
	entry: SessionMessageEntry,
	toolResultsByCallId: Map<string, ToolResultLike>,
): string {
	const segments: string[] = [];
	const message = entry.message;

	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") {
			if (content.length > 0) {
				segments.push(`text:${content}`);
			}
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
					segments.push(`text:${part.text}`);
				}
			}
		}
	} else if (message.role === "assistant") {
		const content = message.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object") {
					continue;
				}
				if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
					segments.push(`text:${part.text}`);
					continue;
				}
				if (part.type === "toolCall") {
					const callId = (part as { id?: unknown }).id;
					const toolName = (part as { name?: unknown }).name;
					const args = (part as { arguments?: unknown }).arguments;
					const result = typeof callId === "string" ? toolResultsByCallId.get(callId) : undefined;
					if (!result) {
						// No matching toolResult yet -> tool call is incomplete in the
						// Pi sense. Skip it (mirrors OpenCode "completed only").
						continue;
					}
					segments.push(
						`tool:${typeof toolName === "string" ? toolName : ""}\ninput:${stableSerialize(args)}\noutput:${formatToolOutputForCorpus(extractToolResultOutput(result))}`,
					);
				}
			}
		}
	} else if (message.role === "toolResult") {
		// ToolResult entries are intentionally NOT given their own searchable
		// segments. Their content is already injected into the matching
		// assistant entry's corpus via `tool:NAME\ninput:...\noutput:...`, so
		// any tool-call pattern resolves to the initiator (mirroring OpenCode
		// where call+result coexist on a single message and matches resolve
		// to that one message). Emitting another segment here would make
		// every tool-call pattern ambiguous against the result row.
	}

	return segments.join(CORPUS_PART_DELIMITER);
}

/**
 * Walk a list of message entries and build a `toolCallId -> toolResult` map
 * keyed off any `toolResult`-role message. Used both for corpus construction
 * and for prune-wrapper detection.
 */
export function buildToolResultIndex(entries: SessionMessageEntry[]): Map<string, ToolResultLike> {
	const map = new Map<string, ToolResultLike>();
	for (const entry of entries) {
		const message = entry.message;
		if (message.role === "toolResult") {
			const callId = (message as { toolCallId?: unknown }).toolCallId;
			if (typeof callId === "string") {
				map.set(callId, message as ToolResultLike);
			}
		}
	}
	return map;
}

export interface ToolResultLike {
	role: "toolResult";
	toolCallId?: string;
	toolName?: string;
	content?: unknown;
	isError?: boolean;
}

/**
 * Format a tool output for inclusion in the search corpus. Strings are passed
 * through as-is so that JSON-text outputs remain matchable against substring
 * patterns like `"status":"ok"`. Structured values fall through to the
 * deterministic stable-serializer so key order is fixed.
 */
function formatToolOutputForCorpus(output: unknown): string {
	if (typeof output === "string") {
		return output;
	}
	return stableSerialize(output);
}

function extractToolResultOutput(result: ToolResultLike): unknown {
	const content = result.content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
					return (part as { text?: unknown }).text ?? "";
				}
				return "";
			})
			.join("\n");
	}
	return content;
}

/** Returns true if the assistant entry contains a completed `context-bonsai-prune` tool call. */
export function isPruneWrapperEntry(
	entry: SessionMessageEntry,
	toolResultsByCallId: Map<string, ToolResultLike>,
): boolean {
	const message = entry.message;
	if (message.role === "assistant") {
		const content = message.content;
		if (!Array.isArray(content)) return false;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if (part.type !== "toolCall") continue;
			if ((part as { name?: unknown }).name !== PRUNE_TOOL_NAME) continue;
			const callId = (part as { id?: unknown }).id;
			if (typeof callId === "string" && toolResultsByCallId.has(callId)) {
				return true;
			}
		}
		return false;
	}
	if (message.role === "toolResult") {
		return (message as { toolName?: unknown }).toolName === PRUNE_TOOL_NAME;
	}
	return false;
}

import { messageMatchesPattern } from "./prune-pattern-matcher.js";

/**
 * Resolve a pattern to a single anchor entry id from the supplied
 * `SessionMessageEntry[]`. Throws a deterministic plain-text error on miss /
 * ambiguity. The ambiguity branch first removes `context-bonsai-prune` wrapper
 * entries from the candidate set, per the shared spec's prune-wrapper filter.
 */
export function resolvePatternBoundary(messageEntries: SessionMessageEntry[], pattern: string): string {
	const toolResultIndex = buildToolResultIndex(messageEntries);

	const matchingEntries = messageEntries.filter((entry) =>
		messageMatchesPattern(buildMessageSearchCorpus(entry, toolResultIndex), pattern),
	);

	if (matchingEntries.length === 0) {
		throw new Error(`No messages match "${pattern}"`);
	}

	if (matchingEntries.length > 1) {
		const nonWrappers = matchingEntries.filter((entry) => !isPruneWrapperEntry(entry, toolResultIndex));
		if (nonWrappers.length === 1) {
			return nonWrappers[0].id;
		}
		throw new Error(`${matchingEntries.length} messages match "${pattern}"; use a more precise pattern`);
	}

	return matchingEntries[0].id;
}

/** Filter helper: select only `SessionMessageEntry` from a heterogeneous branch. */
export function filterMessageEntries(branch: SessionEntry[]): SessionMessageEntry[] {
	return branch.filter((entry): entry is SessionMessageEntry => entry.type === "message");
}
