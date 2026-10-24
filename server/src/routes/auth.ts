import { createHash, webcrypto } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { mkdirDurableSync, writeFileDurableSync } from "../data/durableWrite.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";

type JwtFailure = "no_header" | "expired" | "unknown_key" | "unsupported_alg" | "invalid_signature";

const failureBodies: Record<JwtFailure, { status: 400; error: string; log: string }> = {
    no_header: { status: 400, error: "No auth header", log: "No auth header" },
    expired: { status: 400, error: "Token Expired", log: "Token expired" },
    unknown_key: { status: 400, error: "Unknown Public Key", log: "Unknown public key" },
    unsupported_alg: { status: 400, error: "Unsupported Algorithm", log: "Unsupported algorithm" },
    invalid_signature: { status: 400, error: "Invalid Signature", log: "Invalid signature" },
};

export function hashJSON(json: unknown): string {
    return createHash("sha256").update(JSON.stringify(json)).digest("hex");
}

export type AuthStore = ReturnType<typeof createAuthStore>;

type PasswordState = { state: "unset" | "damaged" } | { state: "set"; value: string };

const damagedPasswordMessage = "Password file is empty. The operator must fix or delete save/server/password.";

function readPasswordState(file: string): PasswordState {
    let password: string;
    try {
        password = readFileSync(file, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { state: "unset" };
        }
        throw error;
    }
    return password.trim() ? { state: "set", value: password } : { state: "damaged" };
}

function readKnownPublicKeys(file: string): string[] {
    let text: string;
    try {
        text = readFileSync(file, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
    try {
        const hashes: unknown = JSON.parse(text);
        if (Array.isArray(hashes) && hashes.every((hash) => typeof hash === "string")) {
            return hashes;
        }
    } catch {}
    const corruptPath = `${file}.corrupt-${Date.now()}`;
    renameSync(file, corruptPath);
    console.warn(`Malformed registered public key file moved to ${corruptPath}; starting with no known keys.`);
    return [];
}

/**
 * Password (`save/server/password`, the client-side SHA-256 digest) and registered ES256 public key
 * hashes (`save/server/known_public_key_hashes.json`), plus JWT verification. `save/server/` is not a
 * storage namespace, so the `/api/*` storage routes cannot reach these files. `bypass` (the
 * loopback-only `pnpm dev:agent` server, `listenConfig.ts`) accepts every token and answers
 * `/api/test_auth` with success, so the tab never asks for a password. `passwordSeed` initializes a
 * missing password file; an empty file keeps setup closed until the operator fixes or deletes it.
 */
export function createAuthStore(savePath: string, options: { bypass?: boolean; passwordSeed?: string } = {}) {
    const bypass = options.bypass === true;
    const serverDir = path.join(savePath, "server");
    mkdirDurableSync(serverDir);
    const passwordPath = path.join(serverDir, "password");
    const knownPublicKeysPath = path.join(serverDir, "known_public_key_hashes.json");

    let password = readPasswordState(passwordPath);
    if (password.state === "damaged") {
        console.warn(`${passwordPath}: ${damagedPasswordMessage}`);
        if (options.passwordSeed) {
            console.warn(`RISU_PASSWORD_SHA256 ignored: ${passwordPath} already exists and is empty.`);
        }
    } else if (password.state === "unset" && options.passwordSeed) {
        writeFileDurableSync(passwordPath, options.passwordSeed);
        password = { state: "set", value: options.passwordSeed };
        console.log(`Initialized ${passwordPath} from RISU_PASSWORD_SHA256.`);
    }
    let knownPublicKeysHashes = readKnownPublicKeys(knownPublicKeysPath);

    async function verifyJwt(token: string | undefined): Promise<JwtFailure | null> {
        if (bypass) {
            return null;
        }
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
        } catch {
            return "invalid_signature";
        }
    }

    function isStoredPassword(token: string | undefined): boolean {
        return password.state === "set" && !!token && token.trim() === password.value.trim();
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

    /** `checkAuth`'s rule for a raw token (a WebSocket handshake): a valid JWT only. */
    async function isAuthorizedToken(token: string | undefined): Promise<boolean> {
        return (await verifyJwt(token)) === null;
    }

    async function isAuthorizedProxyToken(token: string | undefined): Promise<boolean> {
        return isStoredPassword(token) || (await verifyJwt(token)) === null;
    }

    function registerRoutes(
        app: Hono<AppEnv>,
        limiters: { auth: MiddlewareHandler<AppEnv>; login: MiddlewareHandler<AppEnv> },
    ) {
        app.get("/api/test_auth", limiters.auth, async (c) => {
            if (bypass) {
                return c.json({ status: "success" });
            }
            if (password.state === "unset") {
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
            if (password.state === "unset") {
                return c.json({ error: "Password not set" }, 400);
            }
            if (password.state === "damaged") {
                return c.json({ error: damagedPasswordMessage }, 503);
            }
            const body = parsed.body;
            if (typeof body.password === "string" && isStoredPassword(body.password)) {
                const next = [...knownPublicKeysHashes, hashJSON(body.publicKey)];
                writeFileDurableSync(knownPublicKeysPath, JSON.stringify(next));
                knownPublicKeysHashes = next;
                return c.json({ status: "success" });
            }
            return c.json({ error: "Password incorrect" }, 400);
        });

        app.post("/api/crypto", limiters.auth, async (c) => {
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

        app.post("/api/set_password", limiters.login, async (c) => {
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            if (password.state === "damaged") {
                return c.json({ error: damagedPasswordMessage }, 400);
            }
            if (password.state === "set") {
                return c.text("already set", 400);
            }
            const nextPassword = parsed.body.password;
            if (typeof nextPassword !== "string" || !nextPassword.trim()) {
                return c.json({ error: "Password must be a non-empty string" }, 400);
            }
            try {
                writeFileDurableSync(passwordPath, nextPassword);
            } catch (error) {
                // Directory sync can fail after publication. Keep setup closed until disk state is known.
                password = { state: "damaged" };
                password = readPasswordState(passwordPath);
                throw error;
            }
            password = { state: "set", value: nextPassword };
            return c.json({ status: "success" });
        });
    }

    return { checkAuth, checkProxyAuth, isAuthorizedToken, isAuthorizedProxyToken, registerRoutes };
}
