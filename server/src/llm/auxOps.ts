import type { CredentialSlotName } from "../../../shared/llm/credentialSlots.ts";
import type { ResolvedCredential } from "./credentials.ts";

/** A profile's binding resolved by the app against stored records, never a caller-supplied key. */
export type AuxCredential = { slot: CredentialSlotName | null; credential: ResolvedCredential } | { error: string };

/**
 * The auxiliary operations of `/proxy2` (owner answer 2, `implementation-plan.md` step 0): a
 * `risu-aux-op` header names one row, and the server sends the request with its stored credential
 * instead of one the browser holds. Each row fixes the HTTPS origin, the method, the path, the
 * secret, and how it is injected. The callers: OpenAI TTS, DALL-E, Whisper, the memory embeddings
 * and completions, Imagen, and (Phase 5 slice 7b) the model discovery, account, and count calls
 * (`src/ts/network/auxFetch.ts`).
 */
export type AuxOpName =
    | "openai-tts"
    | "openai-dalle"
    | "openai-whisper"
    | "openai-embeddings"
    | "openai-completions"
    | "google-imagen"
    // Phase 5 slice 7b: the browser's model discovery, account, and count calls.
    | "google-models"
    | "anthropic-models"
    | "openai-models"
    | "openrouter-providers"
    | "openrouter-models"
    | "nanogpt-balance"
    | "nanogpt-subscription"
    | "nanogpt-subscription-models"
    | "nanogpt-model-providers"
    | "nanogpt-models"
    | "ollama-cloud-tags"
    | "google-count-tokens";

type AuxSecrets = Record<string, unknown>;

type AuxOp = {
    origin: string;
    method: "GET" | "POST";
    path: RegExp;
    /** The query parameters the request may carry (besides the injected `key`); any other is refused. */
    query?: readonly string[];
    slot?: CredentialSlotName;
    secret: (secrets: AuxSecrets) => unknown;
    inject: "bearer" | "query-key" | "x-api-key";
};

const googleKey = (s: AuxSecrets) =>
    s.google && typeof s.google === "object" ? (s.google as { accessToken?: unknown }).accessToken : "";

const OPENAI = "https://api.openai.com";
const GOOGLE = "https://generativelanguage.googleapis.com";
const NANOGPT = "https://nano-gpt.com";
const OPENROUTER = "https://openrouter.ai";

export const AUX_OPS: Record<AuxOpName, AuxOp> = {
    "openai-tts": {
        origin: OPENAI,
        method: "POST",
        path: /^\/v1\/audio\/speech$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openai-dalle": {
        origin: OPENAI,
        method: "POST",
        path: /^\/v1\/images\/generations$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openai-whisper": {
        origin: OPENAI,
        method: "POST",
        path: /^\/v1\/audio\/transcriptions$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openai-embeddings": {
        origin: OPENAI,
        method: "POST",
        path: /^\/v1\/embeddings$/,
        secret: (s) => s.supaMemoryKey,
        inject: "bearer",
    },
    "openai-completions": {
        origin: OPENAI,
        method: "POST",
        path: /^\/v1\/completions$/,
        secret: (s) => s.supaMemoryKey,
        inject: "bearer",
    },
    "google-imagen": {
        origin: GOOGLE,
        method: "POST",
        path: /^\/v1beta\/models\/[A-Za-z0-9._-]+:predict$/,
        secret: googleKey,
        inject: "query-key",
    },
    "google-models": {
        origin: GOOGLE,
        method: "GET",
        path: /^\/v1beta\/models$/,
        secret: googleKey,
        inject: "query-key",
    },
    "anthropic-models": {
        origin: "https://api.anthropic.com",
        method: "GET",
        path: /^\/v1\/models$/,
        secret: (s) => s.claudeAPIKey,
        inject: "x-api-key",
    },
    "openai-models": {
        origin: OPENAI,
        method: "GET",
        path: /^\/v1\/models$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openrouter-providers": {
        slot: "openrouter",
        origin: OPENROUTER,
        method: "GET",
        path: /^\/api\/v1\/providers$/,
        secret: (s) => s.openrouterKey,
        inject: "bearer",
    },
    "openrouter-models": {
        slot: "openrouter",
        origin: OPENROUTER,
        method: "GET",
        path: /^\/api\/v1\/models$/,
        secret: (s) => s.openrouterKey,
        inject: "bearer",
    },
    "nanogpt-balance": {
        slot: "nanogpt",
        origin: NANOGPT,
        method: "POST",
        path: /^\/api\/check-balance$/,
        secret: (s) => s.nanogptKey,
        inject: "x-api-key",
    },
    "nanogpt-subscription": {
        slot: "nanogpt",
        origin: NANOGPT,
        method: "GET",
        path: /^\/api\/subscription\/v1\/usage$/,
        secret: (s) => s.nanogptKey,
        inject: "bearer",
    },
    "nanogpt-subscription-models": {
        slot: "nanogpt",
        origin: NANOGPT,
        method: "GET",
        path: /^\/api\/subscription\/v1\/models$/,
        query: ["detailed"],
        secret: (s) => s.nanogptKey,
        inject: "bearer",
    },
    "nanogpt-model-providers": {
        slot: "nanogpt",
        origin: NANOGPT,
        method: "GET",
        path: /^\/api\/models\/[^/]+\/providers$/,
        secret: (s) => s.nanogptKey,
        inject: "bearer",
    },
    "nanogpt-models": {
        slot: "nanogpt",
        origin: NANOGPT,
        method: "GET",
        path: /^\/api\/personalized\/v1\/models$/,
        query: ["detailed"],
        secret: (s) => s.nanogptKey,
        inject: "bearer",
    },
    "ollama-cloud-tags": {
        slot: "ollama",
        origin: "https://ollama.com",
        method: "GET",
        path: /^\/api\/tags$/,
        secret: (s) => s.ollamaApiKey,
        inject: "bearer",
    },
    "google-count-tokens": {
        origin: GOOGLE,
        method: "POST",
        path: /^\/v1beta\/models\/[A-Za-z0-9._-]+:countTokens$/,
        secret: googleKey,
        inject: "query-key",
    },
};

export type AuxOpPlan =
    | {
          ok: true;
          url: string;
          headers: Headers;
          /** Every form of the credential the response must not carry: as stored and as injected. */
          secrets: string[];
      }
    | { ok: false; status: 400; error: string };

/**
 * Checks a request against its row and returns the upstream URL and headers with the credential
 * set: the parsed URL must have the row's exact origin and path and no credentials of its own,
 * and the method must match. Caller-sent credential headers and `key` parameters are removed
 * before the server's are added.
 */
export function planAuxOp(
    name: string,
    target: string,
    method: string,
    headers: Headers,
    secrets: AuxSecrets,
    profile?: AuxCredential,
): AuxOpPlan {
    const op = Object.hasOwn(AUX_OPS, name) ? AUX_OPS[name as AuxOpName] : undefined;
    if (!op) {
        return { ok: false, status: 400, error: `Unknown auxiliary operation ${name}` };
    }
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return { ok: false, status: 400, error: "The auxiliary operation's URL is invalid" };
    }
    if (url.origin !== op.origin || url.username || url.password || !op.path.test(url.pathname)) {
        return { ok: false, status: 400, error: `The URL is not the ${name} endpoint` };
    }
    if (method.toUpperCase() !== op.method) {
        return { ok: false, status: 400, error: `${name} takes ${op.method}` };
    }
    let secret = op.secret(secrets);
    if (profile) {
        if (!op.slot) {
            return { ok: false, status: 400, error: `${name} does not take a model profile` };
        }
        if ("error" in profile) {
            return { ok: false, status: 400, error: profile.error };
        }
        if (profile.credential.kind === "refused") {
            return { ok: false, status: 400, error: profile.credential.message };
        }
        if (profile.slot !== op.slot) {
            return { ok: false, status: 400, error: `The model profile does not use the ${op.slot} credential slot` };
        }
        if (profile.credential.kind === "key") {
            secret = profile.credential.key;
        } else if (profile.credential.kind !== "default") {
            return { ok: false, status: 400, error: `${name} requires an API key` };
        }
    }
    if (typeof secret !== "string" || secret.trim() === "") {
        return { ok: false, status: 400, error: `No credential is stored for ${name}` };
    }
    const out = new Headers(headers);
    for (const header of [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "api-key",
        "risu-aux-op",
        "risu-aux-profile",
    ]) {
        out.delete(header);
    }
    for (const param of ["key", "api_key", "token"]) {
        url.searchParams.delete(param);
    }
    for (const param of url.searchParams.keys()) {
        if (!(op.query ?? []).includes(param)) {
            return { ok: false, status: 400, error: `${name} takes no ${param} parameter` };
        }
    }
    const injected = op.inject === "query-key" ? secret : secret.trim();
    if (op.inject === "bearer") {
        out.set("authorization", "Bearer " + injected);
    } else if (op.inject === "x-api-key") {
        out.set("x-api-key", injected);
    } else {
        url.searchParams.set("key", injected);
    }
    return { ok: true, url: url.toString(), headers: out, secrets: [secret, injected] };
}
