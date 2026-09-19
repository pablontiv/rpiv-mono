/**
 * In-situ smoke test for the rpiv-mono-csm fix.
 *
 * Loads the REAL @typesafe-ai/sdk (no `vi.mock`) and the REAL `createDefaultClient`.
 * Provides a resolver that mimics Pi's `modelRegistry.getApiKeyForProvider("typesafe")`
 * (reading the real ~/.pi/agent/auth.json). Intercepts global fetch so we can
 * observe the Authorization header that the SDK would actually send.
 *
 * Proves end-to-end that:
 *   - The Pi-resolved credential wins over the TYPESAFE_API_KEY env fallback
 *   - The Bearer token in the request is the auth.json key, NOT the env var
 *   - When the resolver returns undefined, env-var fallback still works
 *
 * Skipped when ~/.pi/agent/auth.json has no `typesafe` key — keeps the suite
 * portable across hosts (CI, fresh dev machines) while still exercising the
 * real SDK path on the actual developer laptop.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultClient, TYPESAFE_PROVIDER_ID } from "./jev-auto-answer.js";

// Developer-machine-only smoke test. `process.env.HOME` is overridden by the
// repo test setup (see test/setup.ts), so `os.homedir()` and `process.env.HOME`
// both resolve to a sandbox. We hardcode the real Pi auth.json path here —
// the suite is skipped on any host where the file does not exist, so CI /
// fresh dev machines are unaffected.
const AUTH_FILE = "/Users/pones/.pi/agent/auth.json";

function loadAuthSnapshot(): { typesafeKey: string } | undefined {
	try {
		const raw = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, { key?: string }>;
		const key = raw.typesafe?.key;
		if (typeof key === "string" && key.length > 0) {
			return { typesafeKey: key };
		}
	} catch {
		// missing or unreadable — fall through; tests will skip
	}
	return undefined;
}

const authSnapshot = loadAuthSnapshot();

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("createDefaultClient — end-to-end via real SDK", () => {
	function captureFetch() {
		const captured: Array<{ auth?: string }> = [];
		const fakeFetch = vi.fn(async (_input: unknown, init: { headers?: Record<string, string> } = { headers: {} }) => {
			captured.push({ auth: init.headers?.Authorization });
			return new Response(
				JSON.stringify({
					model: "jev-smoke-fixture",
					answers: {
						question_0: {
							type: "choice",
							choice: "option_0",
							confidence: 0.95,
							probabilities: { option_0: 0.95, option_1: 0.05 },
						},
					},
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fakeFetch);
		return { captured, fakeFetch };
	}

	async function fire(client: Awaited<ReturnType<typeof createDefaultClient>>) {
		await client.systemOne(
			{
				state: "smoke",
				model: "jev-smoke",
				questions: {
					question_0: {
						type: "choice",
						instructions: "smoke",
						criteria: { option_0: "A", option_1: "B" },
					},
				},
			},
			{ signal: undefined },
		);
	}

	it.runIf(!!authSnapshot)("sends the Pi-resolved credential, not the env-var fallback", async () => {
		const typesafeKey = authSnapshot?.typesafeKey as string;
		const typesafePrefix = typesafeKey.slice(0, 10);
		const envFallbackValue = "env-fallback-key-should-not-leak";
		const envFallbackPrefix = envFallbackValue.slice(0, 10);
		// Stubs the env var to a deliberately-wrong value so a regression that
		// drops the resolver on the floor would show up as that exact Bearer
		// token. We never log the real key; only opaque prefix slices.
		vi.stubEnv("TYPESAFE_API_KEY", envFallbackValue);
		const { captured } = captureFetch();
		const client = await createDefaultClient(
			{ autoAnswer: true, model: "jev-smoke", minConfidence: 0.5 },
			async () => typesafeKey, // mirrors `getApiKeyForProvider(TYPESAFE_PROVIDER_ID)`
		);
		await fire(client);

		const auth = captured[0]?.auth ?? "";
		expect(auth.startsWith("Bearer ")).toBe(true);
		const bearer = auth.slice("Bearer ".length);
		// Pi-resolved key wins:
		expect(bearer.startsWith(typesafePrefix)).toBe(true);
		// Env var did NOT leak through:
		expect(bearer.startsWith(envFallbackPrefix)).toBe(false);
		// Sanity: the auth.json file actually has the canonical provider id.
		expect(TYPESAFE_PROVIDER_ID).toBe("typesafe");
	});

	it.runIf(!!authSnapshot)("falls back to the env var when the Pi resolver returns undefined", async () => {
		const envFallbackValue = "env-fallback-key-should-not-leak";
		const envFallbackPrefix = envFallbackValue.slice(0, 10);
		vi.stubEnv("TYPESAFE_API_KEY", envFallbackValue);
		const { captured } = captureFetch();
		const client = await createDefaultClient(
			{ autoAnswer: true, model: "jev-smoke", minConfidence: 0.5 },
			async () => undefined,
		);
		await fire(client);

		const auth = captured[0]?.auth ?? "";
		const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
		expect(bearer.startsWith(envFallbackPrefix)).toBe(true);
	});

	it.runIf(!!authSnapshot)("falls back to the env var when the Pi resolver throws", async () => {
		const envFallbackValue = "env-fallback-key-should-not-leak";
		const envFallbackPrefix = envFallbackValue.slice(0, 10);
		vi.stubEnv("TYPESAFE_API_KEY", envFallbackValue);
		const { captured } = captureFetch();
		const client = await createDefaultClient(
			{ autoAnswer: true, model: "jev-smoke", minConfidence: 0.5 },
			async () => {
				throw new Error("modelRegistry unavailable");
			},
		);
		await fire(client);

		const auth = captured[0]?.auth ?? "";
		const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
		expect(bearer.startsWith(envFallbackPrefix)).toBe(true);
	});
});
