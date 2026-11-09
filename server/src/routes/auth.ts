import { createHash, webcrypto } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { type DurableFs, mkdirDurableSync, writeFileDurable, writeFileDurableSync } from "../data/durableWrite.ts";
import { createOrderedWriter, type OrderedWriter } from "../data/orderedWriter.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import { limitedBody } from "./limitedBody.ts";

/**
 * Password setup, browser public-key registration, and registered-key ES256 JWT authentication.
 * server/src/app.ts supplies separate auth and login limiter buckets: GET /api/test_auth and POST
 * /api/crypto use auth; POST /api/login and POST /api/set_password share login. All three POSTs cap
 * bodies at 16 KiB before parsing, without requiring an existing JWT. Login registers a public-key
 * hash after checking the stored password digest; the browser signs its own tokens. Initial setup
 * stores a nonempty supplied password string only while no password file exists. Crypto hashes the
 * supplied data as UTF-8; test_auth is an unauthenticated status check returning unset, incorrect,
 * or success.
 *
 * JWT failures normally answer 400; server/src/routes/storage.ts maps asset failures to 401.
 * checkAuth (including proxy routes) and isAuthorizedToken require a registered ES256 JWT.
 * The optional bypass accepts every token; server/src/listenConfig.ts restricts process startup
 * with bypass to numeric loopback. Files live under save/server, outside the storage namespace.
 * Missing keys start empty, malformed key JSON is renamed aside, and other read failures propagate.
 * Empty password files block setup/login. Per-key operations on server/src/data/orderedWriter.ts
 * publish through server/src/data/durableWrite.ts before installing new state in memory.
 */

/** Browser public-key registration endpoint. */
export const LOGIN_PATH = "/api/login";
/** UTF-8 SHA-256 hashing endpoint. */
export const CRYPTO_PATH = "/api/crypto";
/** Initial password setup endpoint. */
export const SET_PASSWORD_PATH = "/api/set_password";
/** These routes read their bodies before any authentication; a body is a password, or a digest and a JWK. */
export const MAX_AUTH_BODY_BYTES = 16 * 1024;

const KNOWN_KEYS_KEY = "auth:keys";
const PASSWORD_KEY = "auth:password";

type JwtFailure = "no_header" | "expired" | "unknown_key" | "unsupported_alg" | "invalid_signature";

/**
 * Every failed JWT check is a 400 with one of these errors; a malformed token and any parse or crypto
 * exception in `verifyJwt` are `invalid_signature`. The asset route turns each into a 401
 * (`server/src/routes/storage.ts`).
 */
const failureBodies: Record<JwtFailure, { status: 400; error: string; log: string }> = {
    no_header: { status: 400, error: "No auth header", log: "No auth header" },
    expired: { status: 400, error: "Token Expired", log: "Token expired" },
    unknown_key: { status: 400, error: "Unknown Public Key", log: "Unknown public key" },
    unsupported_alg: { status: 400, error: "Unsupported Algorithm", log: "Unsupported algorithm" },
    invalid_signature: { status: 400, error: "Invalid Signature", log: "Invalid signature" },
};

/** SHA-256 hex of the value's JSON.stringify representation. */
export function hashJSON(json: unknown): string {
    return createHash("sha256").update(JSON.stringify(json)).digest("hex");
}

/** Authentication checks and route registration backed by one save directory's auth files. */
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

function readKnownPublicKeys(file: string): Set<string> {
    let text: string;
    try {
        text = readFileSync(file, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return new Set();
        }
        throw error;
    }
    try {
        const hashes: unknown = JSON.parse(text);
        if (Array.isArray(hashes) && hashes.every((hash) => typeof hash === "string")) {
            // A file from before repeat logins were skipped can hold one key many times.
            return new Set(hashes);
        }
    } catch {}
    const corruptPath = `${file}.corrupt-${Date.now()}`;
    renameSync(file, corruptPath);
    console.warn(`Malformed registered public key file moved to ${corruptPath}; starting with no known keys.`);
    return new Set();
}

/**
 * Password (`save/server/password`, the client-side SHA-256 digest) and registered ES256 public key
 * hashes (`save/server/known_public_key_hashes.json`), plus JWT verification. `save/server/` is not a
 * storage namespace, so the `/api/*` storage routes cannot reach these files. `bypass` (the
 * loopback-only `pnpm dev:agent` server, `listenConfig.ts`) accepts every token and answers
 * `/api/test_auth` with success, so the tab never asks for a password. `passwordSeed` initializes a
 * missing password file; an empty file keeps setup closed until the operator fixes or deletes it.
 *
 * A login and a password set are operations on `writer`, one key each: the operation reads the current
 * state, derives the next, writes it durably, and installs it in memory only after the write, so two
 * logins keep both keys and two sets have one winner. `fs` is what those writes call (tests inject
 * latency and failures; default `node:fs/promises`).
 */
export function createAuthStore(
    savePath: string,
    options: { bypass?: boolean; passwordSeed?: string; writer?: OrderedWriter; fs?: DurableFs } = {},
) {
    const bypass = options.bypass === true;
    const writer = options.writer ?? createOrderedWriter();
    const fs = options.fs;
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
            if (!knownPublicKeysHashes.has(hashJSON(jsonPayload.pub))) {
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

    /** `checkAuth`'s rule for a raw token (a WebSocket handshake): a valid JWT only. */
    async function isAuthorizedToken(token: string | undefined): Promise<boolean> {
        return (await verifyJwt(token)) === null;
    }

    function registerRoutes(
        app: Hono<AppEnv>,
        limiters: { auth: MiddlewareHandler<AppEnv>; login: MiddlewareHandler<AppEnv> },
    ) {
        const limitBody = limitedBody(MAX_AUTH_BODY_BYTES);

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

        // With the stored password digest, registers the tab's public key and answers
        // `{ status: "success" }` once its hash is durable. It issues no token: the tab signs its own
        // short-lived ES256 JWT over that key (`src/ts/storage/serverAuth.ts` `createAuth`), which
        // `verifyJwt` checks against these hashes.
        app.post(LOGIN_PATH, limiters.login, limitBody, async (c) => {
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
                const hash = hashJSON(body.publicKey);
                await writer.run(KNOWN_KEYS_KEY, async () => {
                    // A tab logging in again with its registered key changes nothing.
                    if (knownPublicKeysHashes.has(hash)) {
                        return;
                    }
                    const next = new Set([...knownPublicKeysHashes, hash]);
                    await writeFileDurable(knownPublicKeysPath, JSON.stringify([...next]), { fs });
                    knownPublicKeysHashes = next;
                });
                return c.json({ status: "success" });
            }
            return c.json({ error: "Password incorrect" }, 400);
        });

        app.post(CRYPTO_PATH, limiters.auth, limitBody, async (c) => {
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

        app.post(SET_PASSWORD_PATH, limiters.login, limitBody, async (c) => {
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            // The checks run inside the operation: of two calls, the second sees the first's password.
            return await writer.run(PASSWORD_KEY, async () => {
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
                    await writeFileDurable(passwordPath, nextPassword, { fs });
                } catch (error) {
                    // Directory sync can fail after publication. Keep setup closed until disk state is known.
                    password = { state: "damaged" };
                    password = readPasswordState(passwordPath);
                    throw error;
                }
                password = { state: "set", value: nextPassword };
                return c.json({ status: "success" });
            });
        });
    }

    return { checkAuth, isAuthorizedToken, registerRoutes };
}
