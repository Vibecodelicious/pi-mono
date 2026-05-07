// TypeScript declarations for `assert.mjs` so the unit-test suite that drives
// the matchers from synthetic fixtures compiles cleanly under tsgo. The
// runtime file is plain ESM JS (no Pi imports) so the e2e harness can also
// invoke it via `node --input-type=module -e "..."` without a build step.

export interface ToolResultContentPart {
	type: "text";
	text: string;
}

export interface ToolResult {
	isError: boolean;
	content: ToolResultContentPart[];
}

export interface CustomEntry<T = unknown> {
	type: "custom";
	customType: string;
	data: T;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export function eventStreamContainsTool(pathToLog: string, toolName: string): boolean;

export function eventStreamToolResult(pathToLog: string, toolName: string): ToolResult | null;

export function sessionHasCustomEntry<T = unknown>(
	sessionFile: string,
	customType: string,
): CustomEntry<T>[];

export function sessionHasMessageMatching(
	sessionFile: string,
	predicate: (message: unknown) => unknown,
): boolean;

export function countMatchesInEventStream(pathToLog: string, regex: RegExp): number;
