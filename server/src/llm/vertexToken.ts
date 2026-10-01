import { createHash } from "node:crypto";
import { base64url } from "./util.ts";

/**
 * Vertex AI service-account tokens (the client's `generateToken` in `google.ts`), kept in memory
 * instead of in `llmSecrets.vertexAccessToken`: a write there would change the record under the
 * client's mirror, and the token is ephemeral. One token per client email and key, reused until
 * the client's expiry rule (`Date.now() + 3500 s`); concurrent requests share one refresh; `clear`
 * (maintenance, dispose) forgets them all. The stored fields are neither read nor written.
 */
export type VertexTokenCache = ReturnType<typeof createVertexTokenCache>;

const TOKEN_LIFETIME_MS = 3500 * 1000;

export function createVertexTokenCache(options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    const tokens = new Map<string, { token: string; expires: number }>();
    /** One refresh per credential, shared by its waiters; it is aborted when none waits any more. */
    const pending = new Map<string, { promise: Promise<string>; controller: AbortController; waiters: number }>();
    let generation = 0;

    const keyOf = (email: string, privateKey: string) =>
        createHash("sha256").update(email).update("\0").update(privateKey).digest("hex");

    async function generateToken(email: string, key: string, signal: AbortSignal) {
        // Input validation
        if (!email.includes("gserviceaccount.com")) {
            throw new Error("Invalid Vertex client email. Must include gserviceaccount.com");
        }
        if (!key.includes("-----BEGIN PRIVATE KEY-----") || !key.includes("-----END PRIVATE KEY-----")) {
            throw new Error("Invalid Vertex private key. Must include proper key markers.");
        }

        function str2ab(privateKey: string): ArrayBuffer {
            const binaryString = atob(
                privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\n/g, ""),
            );
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes.buffer;
        }

        const time = Math.floor(now() / 1000);

        const header = {
            alg: "RS256",
            typ: "JWT",
        };

        const claimSet = {
            iss: email,
            iat: time,
            exp: time + 3600,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            aud: "https://oauth2.googleapis.com/token",
        };

        const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
        const encodedClaimSet = base64url(new TextEncoder().encode(JSON.stringify(claimSet)));

        const cryptokey = await crypto.subtle.importKey(
            "pkcs8",
            str2ab(key),
            {
                name: "RSASSA-PKCS1-v1_5",
                hash: { name: "SHA-256" },
            },
            false,
            ["sign"],
        );

        const signature = await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            cryptokey,
            new TextEncoder().encode(`${encodedHeader}.${encodedClaimSet}`),
        );

        const jwt = `${encodedHeader}.${encodedClaimSet}.${base64url(new Uint8Array(signature))}`;

        const response = await fetchImpl("https://oauth2.googleapis.com/token", {
            method: "POST",
            body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            signal,
        });

        if (!response.ok) {
            let errorText;
            try {
                errorText = JSON.stringify(await response.json());
            } catch {
                errorText = response.status.toString();
            }
            throw new Error(`Failed to refresh google access token: ${errorText}`);
        }

        const data = (await response.json()) as { access_token?: string };
        const token = data.access_token;

        if (!token) {
            throw new Error("No google access token in the response");
        }
        return token;
    }

    function refreshFor(key: string, email: string, privateKey: string) {
        let entry = pending.get(key);
        if (!entry) {
            const started = generation;
            const controller = new AbortController();
            const promise = generateToken(email, privateKey, controller.signal).then((token) => {
                if (generation === started && !controller.signal.aborted) {
                    tokens.set(key, { token, expires: now() + TOKEN_LIFETIME_MS });
                }
                return token;
            });
            // Observed here, so a refresh nobody waits for any more never becomes an unhandled rejection.
            promise
                .catch(() => {})
                .finally(() => {
                    if (pending.get(key)?.promise === promise) {
                        pending.delete(key);
                    }
                });
            entry = { promise, controller, waiters: 0 };
            pending.set(key, entry);
        }
        return entry;
    }

    return {
        /** A token for these credentials (cached, or one refresh shared by every waiter). */
        async get(email: string, privateKey: string, signal?: AbortSignal): Promise<string> {
            if (signal?.aborted) {
                throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            const key = keyOf(email, privateKey);
            const cached = tokens.get(key);
            if (cached && cached.expires >= now()) {
                return cached.token;
            }
            const entry = refreshFor(key, email, privateKey);
            entry.waiters++;
            try {
                if (!signal) {
                    return await entry.promise;
                }
                return await new Promise<string>((resolve, reject) => {
                    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
                    signal.addEventListener("abort", onAbort, { once: true });
                    entry.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
                });
            } finally {
                entry.waiters--;
                if (entry.waiters === 0 && pending.get(key) === entry) {
                    // The last waiter left (its request ended): the refresh is not needed any more.
                    entry.controller.abort();
                    pending.delete(key);
                }
            }
        },
        /** Maintenance or dispose: every token is forgotten and every refresh aborted. */
        clear() {
            generation++;
            tokens.clear();
            for (const entry of pending.values()) {
                entry.controller.abort();
            }
            pending.clear();
        },
    };
}
