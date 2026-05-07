// Source: opencode-context-bonsai prompt.ts (verbatim port)
export const BONSAI_GUIDANCE = `
# Context Bonsai Plugin - Pruning Guidance

You have access to context-bonsai-prune and context-bonsai-retrieve tools for managing conversation context.

## Prune Flow
- Use pattern selection with from_pattern + to_pattern, plus summary, index_terms, and optional reason.

## Selector Guidance
- Pattern mode must resolve to one unique start and end message each.
- Use specific patterns to avoid ambiguity errors.

## Protected Context
- Default keep protected anchors: system/developer operational rules and overarching session-goal statements.
- protect unresolved task instructions: open parent tasks, pending sub-tasks/side-quests, unmet acceptance criteria, and pending validation/fix loops.
- Protected-anchor examples: governance rules, planning/workflow constraints, and the current session-level objective.
- Unresolved-task examples: "still need to implement", "tests still failing", "follow-up fix pending", or checklist items not yet complete.

## Pruning Decision Order
- In a single turn, identify protected anchors first, then unresolved task instructions, then safe candidate ranges.
- Partition candidates into contiguous blocks that do not cross protected anchors or unresolved-task markers.
- oldest completed contiguous blocks first.
- Candidate tie-break order: completion certainty (high before low), dependency risk (low before high), age (older before newer), then estimated reclaim size (larger first).
- Completion certainty is high only when explicit closure signals exist (done, fixed, completed, resolved, merged/closed test result); otherwise low.
- Dependency risk is high when newer unresolved-task messages reference constraints or decisions in that block; otherwise low.

## Recency and Drift Policy
- Newest content is default keep, with narrow exceptions for clearly completed or redundant recent blocks.
- Early conversation content is usually lower relevance unless it is a protected anchor.
- significant drift requires 2 of 3 signals.
- Signal (a): current objective differs from prior overarching goal text after normalized keyword comparison (lowercase, punctuation removed, word length >= 4, stop words excluded), with zero overlap and a different deliverable noun.
- Signal (b): no unresolved tasks still depend on the protected anchor content.
- Signal (c): one internal candidate sweep across all safe non-protected completed blocks cannot reclaim enough context: either projected usage remains above 60% after reclaim, or reclaimed tokens are below 15% of usable budget while current usage is above 60%.
- Protected anchors may be pruned only when significant drift is true and unresolved tasks do not depend on them.

## Execution Contract
- Perform partitioning and ranking internally and execute prune immediately when a safe range exists.
- do not output partitions or rankings before prune execution.

## Summary Quality
Write 1-3 sentences focusing on decisions made, outcomes reached, and key learnings. Avoid play-by-play descriptions.

## Index Terms
Provide 3-8 keywords covering topics discussed, tools used, files touched, and outcomes achieved.

## Proactive Pruning Triggers
- Completed tasks or project switches
- Multiple gauge readings without pruning action
- Large tool outputs or reference material accumulation
- Completed discussions that can be summarized

## Content Detection Patterns
- Large tool outputs (file contents, command results)
- Completed discussions with clear outcomes
- Reference material that can be summarized
- Repetitive or redundant information

## Quality Gate
Before pruning, verify that key learnings, decisions, and context are preserved in the summary.

## Loop/Iteration Detection
If similar patterns repeat, summarize the iteration process and outcomes rather than keeping all steps.

## Range Partitioning
- Single contiguous range per prune call: select one cohesive, adjacent block bounded by from_pattern and to_pattern.
`;
