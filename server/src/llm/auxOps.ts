/**
 * The auxiliary operations of `/proxy2` (owner answer 2, `implementation-plan.md` step 0): a
 * `risu-aux-op` header names one row, and the server sends the request with its stored credential
 * instead of one the browser holds. Each row fixes the HTTPS origin, the method, the path, the
 * secret, and how it is injected. The browser callers (OpenAI TTS, DALL-E, Whisper, the memory
 * embeddings and completions, Imagen) switch to it in 7b.
 */
export type AuxOpName =
    "openai-tts" | "openai-dalle" | "openai-whisper" | "openai-embeddings" | "openai-completions" | "google-imagen";

type AuxSecrets = { openAIKey?: unknown; supaMemoryKey?: unknown; google?: unknown };

type AuxOp = {
    origin: string;
    method: "POST";
    path: RegExp;
    secret: (secrets: AuxSecrets) => unknown;
    inject: "bearer" | "query-key";
};

export const AUX_OPS: Record<AuxOpName, AuxOp> = {
    "openai-tts": {
        origin: "https://api.openai.com",
        method: "POST",
        path: /^\/v1\/audio\/speech$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openai-dalle": {
        origin: "https://api.openai.com",
        method: "POST",
        path: /^\/v1\/images\/generations$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openai-whisper": {
        origin: "https://api.openai.com",
        method: "POST",
        path: /^\/v1\/audio\/transcriptions$/,
        secret: (s) => s.openAIKey,
        inject: "bearer",
    },
    "openai-embeddings": {
        origin: "https://api.openai.com",
        method: "POST",
        path: /^\/v1\/embeddings$/,
        secret: (s) => s.supaMemoryKey,
        inject: "bearer",
    },
    "openai-completions": {
        origin: "https://api.openai.com",
        method: "POST",
        path: /^\/v1\/completions$/,
        secret: (s) => s.supaMemoryKey,
        inject: "bearer",
    },
    "google-imagen": {
        origin: "https://generativelanguage.googleapis.com",
        method: "POST",
        path: /^\/v1beta\/models\/[A-Za-z0-9._-]+:predict$/,
        secret: (s) =>
            s.google && typeof s.google === "object" ? (s.google as { accessToken?: unknown }).accessToken : "",
        inject: "query-key",
    },
};

export type AuxOpPlan =
    { ok: true; url: string; headers: Headers; secret: string } | { ok: false; status: 400; error: string };

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
    const secret = op.secret(secrets);
    if (typeof secret !== "string" || secret.trim() === "") {
        return { ok: false, status: 400, error: `No credential is stored for ${name}` };
    }
    const out = new Headers(headers);
    for (const header of ["authorization", "x-api-key", "x-goog-api-key", "api-key", "risu-aux-op"]) {
        out.delete(header);
    }
    for (const param of ["key", "api_key", "token"]) {
        url.searchParams.delete(param);
    }
    if (op.inject === "bearer") {
        out.set("authorization", "Bearer " + secret.trim());
    } else {
        url.searchParams.set("key", secret);
    }
    return { ok: true, url: url.toString(), headers: out, secret };
}
