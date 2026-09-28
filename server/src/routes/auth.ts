import { createHash, webcrypto } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";

type JwtFailure = "no_header" | "expired" | "unknown_key" | "unsupported_alg" | "invalid_signature" | "error";

const failureBodies: Record<JwtFailure, { status: 400 | 500; error: string; log: string }> = {
    no_header: { status: 400, error: "No auth header", log: "No auth header" },
    expired: { status: 400, error: "Token Expired", log: "Token expired" },
    unknown_key: { status: 400, error: "Unknown Public Key", log: "Unknown public key" },
    unsupported_alg: { status: 400, error: "Unsupported Algorithm", log: "Unsupported algorithm" },
    invalid_signature: { status: 400, error: "Invalid Signature", log: "Invalid signature" },
    error: { status: 500, error: "Internal Server Error", log: "" },
};

export function hashJSON(json: unknown): string {
    return createHash("sha256").update(JSON.stringify(json)).digest("hex");
}

export type AuthStore = ReturnType<typeof createAuthStore>;

/**
 * Password (`save/__password`, the client-side SHA-256 digest) and registered ES256 public key
 * hashes (`save/__known_public_key_hashes.json`), plus JWT verification.
 */
export function createAuthStore(savePath: string) {
    const passwordPath = path.join(savePath, "__password");
    const knownPublicKeysPath = path.join(savePath, "__known_public_key_hashes.json");

    let password = existsSync(passwordPath) ? readFileSync(passwordPath, "utf-8") : "";
    const knownPublicKeysHashes: string[] = existsSync(knownPublicKeysPath)
        ? JSON.parse(readFileSync(knownPublicKeysPath, "utf-8"))
        : [];

    async function verifyJwt(token: string | undefined): Promise<JwtFailure | null> {
        if (!token) {
            return "no_header";
        }
        try {
            const [jsonHeaderB64, jsonPayloadB64, signatureB64] = token.split(".");
            //alg, typ
            const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, "base64url").toString("utf-8"));
            //iat, exp, pub
            const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, "base64url").toString("utf-8"));
            const signature = Buffer.from(signatureB64, "base64url");

            const now = Math.floor(Date.now() / 1000);
            if (jsonPayload.exp < now) {
                return "expired";
            }
            if (!knownPublicKeysHashes.includes(hashJSON(jsonPayload.pub))) {
                return "unknown_key";
            }
            //only support ECDSA for now
            if (jsonHeader.alg !== "ES256") {
                return "unsupported_alg";
            }
            const isValid = await webcrypto.subtle.verify(
                { name: "ECDSA", hash: { name: "SHA-256" } },
                await webcrypto.subtle.importKey(
                    "jwk",
                    jsonPayload.pub,
                    { name: "ECDSA", namedCurve: "P-256" },
                    false,
                    ["verify"],
                ),
                signature,
                Buffer.from(`${jsonHeaderB64}.${jsonPayloadB64}`),
            );
            return isValid ? null : "invalid_signature";
        } catch (error) {
            console.log(error);
            return "error";
        }
    }

    function isStoredPassword(token: string | undefined): boolean {
        return !!token && token.trim() === password.trim();
    }

    /** Returns the error response for a failed JWT check, or null when authorized. */
    async function checkAuth(c: Context<AppEnv>): Promise<Response | null> {
        const failure = await verifyJwt(c.req.header("risu-auth"));
        if (!failure) {
            return null;
        }
        const body = failureBodies[failure];
        if (body.log) {
            console.log(body.log);
        }
        return c.json({ error: body.error }, body.status);
    }

    /** Proxy routes also accept the stored password digest itself. */
    async function checkProxyAuth(c: Context<AppEnv>): Promise<Response | null> {
        if (isStoredPassword(c.req.header("risu-auth"))) {
            return null;
        }
        return await checkAuth(c);
    }

    async function isAuthorizedProxyToken(token: string | undefined): Promise<boolean> {
        return isStoredPassword(token) || (await verifyJwt(token)) === null;
    }

    function registerRoutes(
        app: Hono<AppEnv>,
        limiters: { auth: MiddlewareHandler<AppEnv>; login: MiddlewareHandler<AppEnv> },
    ) {
        app.get("/api/test_auth", limiters.auth, async (c) => {
            if (!password) {
                return c.json({ status: "unset" });
            }
            if (await verifyJwt(c.req.header("risu-auth"))) {
                return c.json({ status: "incorrect" });
            }
            return c.json({ status: "success" });
        });

        app.post("/api/login", limiters.login, async (c) => {
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            if (password === "") {
                return c.json({ error: "Password not set" }, 400);
            }
            const body = parsed.body;
            if (body.password && body.password.trim() === password.trim()) {
                knownPublicKeysHashes.push(hashJSON(body.publicKey));
                writeFileSync(knownPublicKeysPath, JSON.stringify(knownPublicKeysHashes), "utf-8");
                return c.json({ status: "success" });
            }
            return c.json({ error: "Password incorrect" }, 400);
        });

        app.post("/api/crypto", async (c) => {
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            try {
                return c.text(createHash("sha256").update(Buffer.from(parsed.body.data, "utf-8")).digest("hex"));
            } catch {
                return c.json({ error: "Crypto operation failed" }, 500);
            }
        });

        app.post("/api/set_password", async (c) => {
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            if (password !== "") {
                return c.text("already set", 400);
            }
            // Persist before updating memory so a rejected value (e.g. missing) leaves the server unset.
            const nextPassword = parsed.body.password;
            writeFileSync(passwordPath, nextPassword, "utf-8");
            password = nextPassword;
            return c.json({ status: "success" });
        });
    }

    return { checkAuth, checkProxyAuth, isAuthorizedProxyToken, registerRoutes };
}
