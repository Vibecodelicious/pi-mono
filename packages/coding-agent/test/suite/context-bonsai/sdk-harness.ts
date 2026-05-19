/**
 * SDK-based integration harness for the Context Bonsai integration tests.
 *
 * This harness is built entirely on Pi's public SDK surface
 * (`createAgentSession`, `DefaultResourceLoader`, `AuthStorage`,
 * `ModelRegistry`, `SessionManager`, `SettingsManager`, all from the
 * `@mariozechner/pi-coding-agent` package entry point). It imports no
 * non-public test helper and no `src/` deep path, so the Context Bonsai
 * integration tests can run outside the pi-mono monorepo.
 *
 * The faux provider from `@mariozechner/pi-ai` drives every model call, so no
 * live LLM or credentials are needed.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxModelDefinition, FauxProviderRegistration, FauxResponseStep, Model } from "@mariozechner/pi-ai";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

export interface HarnessOptions {
	/** Extension factories to load into the session (e.g. the bonsai factory). */
	extensionFactories?: ExtensionFactory[];
	/** Faux model definitions; defaults to the faux provider's single model. */
	models?: FauxModelDefinition[];
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-bonsai-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Register the faux model's provider metadata and request auth on the
 * ModelRegistry so the SDK's `streamFn` resolves a credential for it. The faux
 * `api` itself is already on the global pi-ai api registry — `registerFauxProvider`
 * puts it there — so model calls dispatch to the faux provider directly.
 */
function bindFauxModelRegistry(modelRegistry: ModelRegistry, faux: FauxProviderRegistration): void {
	const model = faux.getModel();
	modelRegistry.registerProvider(model.provider, {
		api: faux.api,
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	});
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const faux = registerFauxProvider({ models: options.models });
	faux.setResponses([]);
	const model = faux.getModel();

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");

	const modelRegistry = ModelRegistry.inMemory(authStorage);
	bindFauxModelRegistry(modelRegistry, faux);

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory();

	// Hermetic resource loader: temp cwd/agentDir carry no `.pi/` entries, and
	// filesystem extension/skill/context-file discovery is disabled, so the
	// bonsai factory is the only extension loaded.
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: options.extensionFactories ?? [],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model,
		authStorage,
		modelRegistry,
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	// `createAgentSession` returns an unbound session; binding emits the initial
	// `session_start` so extensions install their tools and hooks. Passing an
	// `onError` listener makes `AgentSession.reload()` re-emit `session_start`
	// with `reason: "reload"`, which the bonsai extension needs to re-hydrate
	// archive state from the persisted session entries.
	await session.bindExtensions({ onError: () => {} });

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux,
		models: faux.models,
		setResponses: faux.setResponses,
		appendResponses: faux.appendResponses,
		getPendingResponseCount: faux.getPendingResponseCount,
		events,
		tempDir,
		cleanup() {
			session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
