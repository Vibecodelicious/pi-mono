/**
 * Unit tests for the credential-discovery shim at `test/e2e/check-credentials.ts`.
 *
 * These tests use `AuthStorage.inMemory(...)` (auth-storage.ts:203) so they
 * never touch the real `~/.pi/agent/auth.json`. They cover the five fixture
 * cases mandated by Story P.5 iter 2's amended ACs:
 *
 *   (i)   api_key-shape entry for the configured provider     -> gate open
 *   (ii)  oauth-shape entry for the configured provider       -> gate open
 *   (iii) entry for a different provider only                 -> gate closed
 *   (iv)  BONSAI_E2E_API_KEY runtime override only            -> gate open
 *   (v)   no source present                                   -> gate closed
 *
 * Plus a focused check that the deterministic error message names the
 * auth-store path, the BONSAI_E2E_API_KEY env var, and the `pi login` next
 * step — these are the operator-self-diagnostic invariants.
 */

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkCredentials } from "./e2e/check-credentials.js";

const FAKE_AUTH_PATH = "/fake/agent/auth.json";
const FAKE_AGENT_DIR_ENV = "$PI_CODING_AGENT_DIR";

// env-api-keys.ts looks at process.env directly. To keep these tests
// hermetic we save/restore the env vars our fixtures might collide with so
// the host environment never affects gate decisions.
const PROVIDER_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"AZURE_OPENAI_API_KEY",
] as const;

describe("checkCredentials (credential-discovery shim core)", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of PROVIDER_ENV_VARS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of PROVIDER_ENV_VARS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	test("(i) api_key-shape entry for the configured provider opens the gate", () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-test-anthropic" },
		});
		const result = checkCredentials(storage, "anthropic", undefined, FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(result.ok).toBe(true);
		expect(result.errorMessage).toBeUndefined();
	});

	test("(ii) oauth-shape entry for the configured provider opens the gate", () => {
		const storage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "fake-access-token",
				refresh: "fake-refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		const result = checkCredentials(storage, "anthropic", undefined, FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(result.ok).toBe(true);
		expect(result.errorMessage).toBeUndefined();
	});

	test("(iii) entry for a different provider only closes the gate with deterministic error", () => {
		const storage = AuthStorage.inMemory({
			openai: { type: "api_key", key: "sk-test-openai" },
		});
		const result = checkCredentials(storage, "anthropic", undefined, FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toBeDefined();
		// Operator-self-diagnostic invariants:
		expect(result.errorMessage).toContain(FAKE_AUTH_PATH);
		expect(result.errorMessage).toContain("BONSAI_E2E_API_KEY");
		expect(result.errorMessage).toContain("pi login anthropic");
		expect(result.errorMessage).toContain(FAKE_AGENT_DIR_ENV);
	});

	test("(iv) BONSAI_E2E_API_KEY runtime override only opens the gate", () => {
		const storage = AuthStorage.inMemory({}); // no entries
		const result = checkCredentials(storage, "anthropic", "sk-runtime-override", FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(result.ok).toBe(true);
		expect(result.errorMessage).toBeUndefined();
	});

	test("(v) no source present closes the gate with deterministic error", () => {
		const storage = AuthStorage.inMemory({});
		const result = checkCredentials(storage, "anthropic", undefined, FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toBeDefined();
		expect(result.errorMessage).toContain(FAKE_AUTH_PATH);
		expect(result.errorMessage).toContain("BONSAI_E2E_API_KEY");
		expect(result.errorMessage).toContain("pi login anthropic");
	});

	test("override participates in Pi's priority order (set even when entry exists)", () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-from-auth-json" },
		});
		// Override + entry both present -> gate open. (Pi's getApiKey() would
		// prefer the override; hasAuth() just confirms any source exists.)
		const result = checkCredentials(storage, "anthropic", "sk-runtime-override", FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(result.ok).toBe(true);
	});

	test("provider-specific check: openai entry does not open gate for anthropic provider", () => {
		// Symmetric to (iii) but exercises the openai/anthropic split in particular.
		const storage = AuthStorage.inMemory({
			openai: { type: "api_key", key: "sk-test-openai" },
		});
		const anthropicResult = checkCredentials(storage, "anthropic", undefined, FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(anthropicResult.ok).toBe(false);
		const openaiResult = checkCredentials(storage, "openai", undefined, FAKE_AUTH_PATH, FAKE_AGENT_DIR_ENV);
		expect(openaiResult.ok).toBe(true);
	});
});
