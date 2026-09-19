/**
 * Regression tests for the `getProviderAuth` fix (bead rpiv-mono-csm):
 * Jev auto-answer must prefer the credential saved by `Pi /login typesafe`
 * (resolved via `modelRegistry.getApiKeyForProvider("typesafe")`) over the
 * TYPESAFE_API_KEY environment variable, so users who already ran
 * `/login typesafe` never get re-prompted when auto-answer is enabled.
 *
 * Kept in a separate file from `jev-auto-answer.test.ts` because the
 * `vi.mock("@typesafe-ai/sdk", ...)` block at the top of this file would
 * otherwise replace the SDK module globally and break the existing
 * "dynamically loads the real SDK" test in the sibling file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedJevConfig } from "./config.js";
import { autoAnswerWithJev, createDefaultClient, type JevClient, TYPESAFE_PROVIDER_ID } from "./jev-auto-answer.js";
import type { QuestionParams } from "./tool/types.js";

// Capture every `TypeSafeClient` constructor call so each test can assert
// which `apiKey` the package forwarded to the SDK. `vi.hoisted` runs before
// the (also hoisted) `vi.mock` factory so the closure can reference a stable
// spy without hitting a TDZ on `const typeSafeClientCtor`.
const { typeSafeClientCtor } = vi.hoisted(() => ({
	typeSafeClientCtor: vi.fn(),
}));
vi.mock("@typesafe-ai/sdk", () => {
	class FakeTypeSafeClient {
		systemOne = vi.fn();
		constructor(config: unknown) {
			typeSafeClientCtor(config);
		}
	}
	return { TypeSafeClient: FakeTypeSafeClient };
});

const CONFIG: ResolvedJevConfig = { autoAnswer: true, model: "jev-latest", minConfidence: 0.5 };

const PARAMS: QuestionParams = {
	state: "The app is a small TypeScript CLI and must minimize dependencies.",
	questions: [
		{
			question: "Which storage should it use?",
			header: "Storage",
			options: [
				{ label: "JSON", description: "One local file" },
				{ label: "SQLite", description: "Embedded database" },
			],
		},
	],
};

function stubClientWith(response: unknown): JevClient {
	return { systemOne: vi.fn(async () => response) as never };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	typeSafeClientCtor.mockClear();
});

describe("createDefaultClient — TypeSafe credential resolution", () => {
	it("forwards a Pi-resolved key as `apiKey` to the TypeSafeClient", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key-should-not-be-used");
		const resolver = vi.fn(async () => "pi-registry-key-from-auth-json");

		await createDefaultClient(CONFIG, resolver);

		expect(resolver).toHaveBeenCalledOnce();
		expect(typeSafeClientCtor).toHaveBeenCalledOnce();
		expect(typeSafeClientCtor).toHaveBeenCalledWith({
			apiKey: "pi-registry-key-from-auth-json",
			defaultModel: CONFIG.model,
		});
	});

	it("falls back to the env var when the Pi resolver returns undefined", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key");
		const resolver = vi.fn(async () => undefined);

		await createDefaultClient(CONFIG, resolver);

		expect(resolver).toHaveBeenCalledOnce();
		expect(typeSafeClientCtor).toHaveBeenCalledWith({
			// SDK's `fromCodeOrEnv` reads TYPESAFE_API_KEY from process.env when
			// the explicit `apiKey` is undefined.
			apiKey: undefined,
			defaultModel: CONFIG.model,
		});
	});

	it("falls back to the env var when no resolver is supplied", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key");

		await createDefaultClient(CONFIG);

		expect(typeSafeClientCtor).toHaveBeenCalledOnce();
		expect(typeSafeClientCtor).toHaveBeenCalledWith({
			apiKey: undefined,
			defaultModel: CONFIG.model,
		});
	});

	it("falls back to the env var when the Pi resolver throws (registry unavailable)", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key");
		const resolver = vi.fn(async () => {
			throw new Error("modelRegistry is not available in this host");
		});

		await createDefaultClient(CONFIG, resolver);

		expect(resolver).toHaveBeenCalledOnce();
		expect(typeSafeClientCtor).toHaveBeenCalledWith({
			apiKey: undefined,
			defaultModel: CONFIG.model,
		});
	});

	it("exposes the canonical provider id used by `Pi /login typesafe`", () => {
		expect(TYPESAFE_PROVIDER_ID).toBe("typesafe");
	});
});

describe("autoAnswerWithJev — apiKeyResolver plumbing", () => {
	it("threads the apiKeyResolver through to the client factory", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key-should-not-be-used");
		const factory = vi.fn(
			async () =>
				stubClientWith({
					model: "jev-stub",
					answers: {},
					usage: { input_tokens: 0, output_tokens: 0 },
				}) as JevClient,
		);
		const resolver = vi.fn(async () => "pi-registry-key-from-auth-json");

		await autoAnswerWithJev(PARAMS, CONFIG, undefined, factory, resolver);

		expect(factory).toHaveBeenCalledOnce();
		const [, forwardedResolver] = factory.mock.calls[0] as unknown as [unknown, unknown];
		expect(forwardedResolver).toBe(resolver);
		// The factory stub returns a fake client, so `createDefaultClient` (and
		// therefore the mock SDK ctor) is never invoked in this test path.
		expect(typeSafeClientCtor).not.toHaveBeenCalled();
	});

	it("threads an undefined resolver as `undefined` (env fallback path)", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key");
		const factory = vi.fn(
			async () =>
				stubClientWith({
					model: "jev-stub",
					answers: {},
					usage: { input_tokens: 0, output_tokens: 0 },
				}) as JevClient,
		);

		await autoAnswerWithJev(PARAMS, CONFIG, undefined, factory, undefined);

		expect(factory).toHaveBeenCalledOnce();
		const [, forwardedResolver] = factory.mock.calls[0] as unknown as [unknown, unknown];
		expect(forwardedResolver).toBeUndefined();
		expect(typeSafeClientCtor).not.toHaveBeenCalled();
	});

	it("default factory uses Pi-resolved key when the caller threads it", async () => {
		// End-to-end through `autoAnswerWithJev`'s default factory path.
		vi.stubEnv("TYPESAFE_API_KEY", "env-fallback-key-should-not-be-used");
		const resolver = vi.fn(async () => "pi-registry-key-from-auth-json");
		const stubClient = stubClientWith({
			model: "jev-stub",
			answers: {},
			usage: { input_tokens: 0, output_tokens: 0 },
		}) as JevClient;

		await autoAnswerWithJev(
			PARAMS,
			CONFIG,
			undefined,
			async (cfg, r) => {
				// Mirror `createDefaultClient` exactly: forward the resolver so
				// the credential reaches the SDK constructor.
				expect(r).toBe(resolver);
				return createDefaultClient(cfg, r);
			},
			resolver,
		);

		expect(resolver).toHaveBeenCalledOnce();
		expect(typeSafeClientCtor).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "pi-registry-key-from-auth-json", defaultModel: CONFIG.model }),
		);
		// Reference the variable so vitest doesn't complain about an unused return.
		expect(stubClient).toBeDefined();
	});
});
