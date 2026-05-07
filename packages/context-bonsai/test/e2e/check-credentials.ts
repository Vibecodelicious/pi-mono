/**
 * Credential-discovery shim for the context-bonsai e2e harness.
 *
 * Defers to Pi's documented credential resolution rather than re-implementing
 * env-var or auth.json parsing. Per the per-agent spec (E2E Credential
 * Discovery section) and Story P.5's amended ACs, the shim:
 *
 *   1. Reads BONSAI_E2E_PROVIDER (default "anthropic") and the optional
 *      harness override BONSAI_E2E_API_KEY.
 *   2. Loads file-backed AuthStorage (which honours $PI_CODING_AGENT_DIR via
 *      getAgentDir() in coding-agent/src/config.ts).
 *   3. If BONSAI_E2E_API_KEY is set, applies it via setRuntimeApiKey() so it
 *      participates in Pi's documented priority order (auth-storage.ts:415-422,
 *      runtime override is highest priority).
 *   4. Calls AuthStorage.hasAuth(provider). On true, exits 0 (gate open). On
 *      false, prints a deterministic error to stderr that names the auth-store
 *      path, the BONSAI_E2E_API_KEY override, and the operator-actionable next
 *      step (`pi login <provider>` or set BONSAI_E2E_API_KEY), then exits 3.
 *
 * The core decision is exposed as the pure function `checkCredentials` so unit
 * tests can drive it with `AuthStorage.inMemory()` without touching the real
 * auth.json. The CLI entrypoint (this file's bottom-of-module block) composes
 * the pure function with `AuthStorage.create()` and `process.exit`.
 */

import { join } from "node:path";
import { AuthStorage, getAgentDir } from "@mariozechner/pi-coding-agent";

export interface CheckCredentialsResult {
	ok: boolean;
	errorMessage?: string;
}

/**
 * Pure decision function. Mutates `storage` (applies the runtime override when
 * present), then queries `hasAuth(provider)`.
 *
 * The error message format is normative: it must name (i) the auth-store path,
 * (ii) the harness override BONSAI_E2E_API_KEY, and (iii) the operator next
 * step (`pi login <provider>` or set the override). Tests pin these elements.
 */
export function checkCredentials(
	storage: AuthStorage,
	provider: string,
	override: string | undefined,
	authStorePath: string,
	agentDirEnvHint: string,
): CheckCredentialsResult {
	if (override) {
		storage.setRuntimeApiKey(provider, override);
	}
	if (storage.hasAuth(provider)) {
		return { ok: true };
	}
	const errorMessage = [
		`bonsai e2e: no credential found for provider "${provider}".`,
		`  AuthStorage.hasAuth("${provider}") returned false; checked: runtime override, ${authStorePath}, env vars (see packages/ai/src/env-api-keys.ts), models.json fallback.`,
		`  auth-store path resolves via getAuthPath()/getAgentDir() (override with ${agentDirEnvHint}).`,
		`  harness override env var: BONSAI_E2E_API_KEY (applied via setRuntimeApiKey before the check).`,
		`  next step: run \`pi login ${provider}\` for an interactive login, OR export BONSAI_E2E_API_KEY=<key> for a non-persisted runtime override.`,
	].join("\n");
	return { ok: false, errorMessage };
}

// CLI entrypoint. Skips when this module is imported (e.g. by unit tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	const provider = process.env.BONSAI_E2E_PROVIDER ?? "anthropic";
	const override = process.env.BONSAI_E2E_API_KEY;
	const authStorePath = join(getAgentDir(), "auth.json");
	const agentDirEnvHint = "$PI_CODING_AGENT_DIR";
	const storage = AuthStorage.create();
	const result = checkCredentials(storage, provider, override, authStorePath, agentDirEnvHint);
	if (result.ok) {
		process.exit(0);
	}
	process.stderr.write(`${result.errorMessage}\n`);
	process.exit(3);
}
