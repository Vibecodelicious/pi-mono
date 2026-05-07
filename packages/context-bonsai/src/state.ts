/**
 * Per-extension state for context-bonsai.
 *
 * Selectively ported from `opencode_context_bonsai_plugin/src/state.ts`. We
 * intentionally keep ONLY `turnCount` (used by the gauge cadence in Story 4)
 * and drop everything else:
 *
 * - `tokenCache` / `modelLimitCache`: Pi exposes `ctx.getContextUsage()`
 *   directly, so caching is unnecessary.
 * - `idVisibility`: Pi's placeholder `[PRUNED: <anchor> to <range-end>]` carries
 *   the anchor id literally, so the OpenCode `[msg:<id>]` text-prefix transform
 *   has no equivalent here.
 * - `sameStepPrunes`: Pi intentionally does not port OpenCode's same-step
 *   guard. Same-turn prune+retrieve resolves to a tombstone-wins no-op, which
 *   does not need a per-session guard set.
 *
 * The state is a single shared object owned by the extension factory; Pi
 * runs one factory instance per agent process and bonsai never shares state
 * across processes, so a flat object suffices (no per-session keying needed
 * for `turnCount` because the factory closure rebuilds on session reload).
 */

export interface BonsaiState {
	/** Total LLM-call turns observed since session_start; used by Story 4. */
	turnCount: number;
}

export function createState(): BonsaiState {
	return { turnCount: 0 };
}
