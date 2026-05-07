/**
 * Context-pressure gauge: builds a `<system-reminder>` text block and appends
 * it to the last user message on a cadence so the LLM can autonomously decide
 * to call `context-bonsai-prune`.
 *
 * Adapted from `opencode_context_bonsai_plugin/src/gauge.ts`. Pi-specific
 * differences:
 *
 * - We do NOT cache token / model-limit data ourselves; Pi exposes
 *   `ctx.getContextUsage()` which already reflects the active model and the
 *   latest assistant usage. The host owns the bookkeeping.
 * - The injection target is Pi's `AgentMessage[]` (last `role: "user"` message
 *   with `content` as either `string` or an array of `TextContent | ImageContent`).
 *   If the content is a string we normalise it to an array first, then push a
 *   `TextContent` part — same model-visible result as OpenCode's `parts.push`.
 * - Severity-band text matches the cross-agent spec verbatim (four locked
 *   bands; `>80%` carries `PRUNE NOW`).
 * - The cadence counter lives in `state.turnCount` and is incremented inside
 *   `maybeInjectGauge` itself: every call advances; every `GAUGE_CADENCE`-th
 *   call fires.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import type { BonsaiState } from "./state.js";

export const GAUGE_CADENCE = 5;

const SELECTION_CONTRACT =
	"Protect operational-rule and overarching-goal anchors, protect unresolved task instructions, and prune oldest completed contiguous blocks first. In a single turn, rank safe blocks by completion certainty, dependency risk, age, then reclaim size, execute prune immediately, and do not output partitions or rankings.";

/**
 * Build the gauge body string per the cross-agent spec's four locked severity
 * bands. Caller wraps in `<system-reminder>...</system-reminder>`.
 */
export function formatGaugeText(used: number, usableBudget: number, percent: number): string {
	const baseGauge = `[CONTEXT GAUGE: ${used} / ${usableBudget} tokens (${percent}%)]`;

	if (percent < 30) {
		return `${baseGauge} ${SELECTION_CONTRACT} Then continue your work.`;
	}
	if (percent <= 60) {
		return `${baseGauge} ${SELECTION_CONTRACT} Pruning is not destructive - a summary is left behind and the original content can be retrieved later.`;
	}
	if (percent <= 80) {
		return `${baseGauge} ${SELECTION_CONTRACT} Newest content is default keep, with narrow exceptions for clearly completed or redundant recent blocks. significant drift requires 2 of 3 signals before pruning protected anchors; signal (c) is unmet reclaim below 60% usage or below 15% of usable budget while above 60%. Pruning is not destructive - a summary is left behind and the original content can be retrieved later.`;
	}
	return `[CONTEXT GAUGE: ${used} / ${usableBudget} tokens (${percent}%) - PRUNE NOW] ${SELECTION_CONTRACT} Newest content is default keep, with narrow exceptions for clearly completed or redundant recent blocks. significant drift requires 2 of 3 signals before pruning protected anchors; signal (c) is unmet reclaim below 60% usage or below 15% of usable budget while above 60%. Pruning is not destructive - a summary is left behind and the original content can be retrieved later. Failure to prune immediately will lead to significantly degraded performance.`;
}

/**
 * Increment the turn counter and, on every `GAUGE_CADENCE`-th call, append a
 * `<system-reminder>` gauge block to the last user message.
 *
 * Returns the input array (or a shallow-copy with the last user message
 * replaced by a new object that owns a fresh content array, when injection
 * fires — we avoid mutating shared state since the same array may be referenced
 * elsewhere in the host). The counter advances on every call regardless of
 * whether usage data is available — this matches OpenCode's semantics so
 * cadence stays predictable across the session even when usage flickers
 * (e.g. immediately after compaction).
 */
export function maybeInjectGauge(
	messages: AgentMessage[],
	state: BonsaiState,
	usage: ContextUsage | undefined,
): AgentMessage[] {
	state.turnCount += 1;

	if (state.turnCount % GAUGE_CADENCE !== 0) {
		return messages;
	}

	if (!usage || usage.tokens === null) {
		return messages;
	}

	const used = usage.tokens;
	const usableBudget = usage.contextWindow;
	if (typeof usableBudget !== "number" || usableBudget <= 0) {
		return messages;
	}

	const percent =
		typeof usage.percent === "number" ? Math.round(usage.percent) : Math.round((used / usableBudget) * 100);

	// Find last user message.
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown };
		if (m.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	if (lastUserIdx === -1) {
		return messages;
	}

	const gaugeText = `<system-reminder>\n${formatGaugeText(used, usableBudget, percent)}\n</system-reminder>`;
	const target = messages[lastUserIdx] as { role: "user"; content: unknown };

	// Normalise string content to array form so we can push a TextContent part.
	let contentArr: Array<{ type: string; text?: string }>;
	if (typeof target.content === "string") {
		contentArr = target.content.length > 0 ? [{ type: "text", text: target.content }] : [];
	} else if (Array.isArray(target.content)) {
		// Copy so we don't mutate a shared content array held by the caller's
		// AgentMessage (e.g. a session entry that's also live in the persisted
		// state). The new TextContent part is appended only on this copy.
		contentArr = [...(target.content as Array<{ type: string; text?: string }>)];
	} else {
		// Defensive: unexpected shape — skip rather than corrupt.
		return messages;
	}

	contentArr.push({ type: "text", text: gaugeText });

	// Build a fresh AgentMessage with the new content array; leave other
	// fields intact via spread.
	const replacedTarget = { ...(messages[lastUserIdx] as object), content: contentArr } as AgentMessage;
	const out = messages.slice();
	out[lastUserIdx] = replacedTarget;
	return out;
}
