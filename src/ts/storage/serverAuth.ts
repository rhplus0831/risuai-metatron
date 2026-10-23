import { language } from "src/lang";
import { alertError, alertInput, waitAlert } from "../alert";
import { base64url, getKeypairStore, saveKeypairStore } from "../util";

/**
 * The tab's authentication with the self-host server (split out of the old storage client): one
 * state for every caller (the resource client, the asset client, the proxy, the sockets). This
 * browser has a non-extractable ECDSA P-256 key pair (stored under `"node"`); a request carries a
 * fresh ES256 JWT over its public key (`risu-auth`, valid five minutes). The first check asks the
 * server whether the key is known (`/api/test_auth`): on a fresh server the password is set, then
 * the key registered with it; with an unknown key the password is asked and the key registered. One
 * check runs at a time; parallel callers wait for it, and a failed one is tried again next time.
 */

function JSONStringlifyAndbase64Url(obj: unknown) {
    return base64url(Buffer.from(JSON.stringify(obj), "utf-8"));
}

async function getKeyPair(): Promise<CryptoKeyPair> {
    const storedKey = await getKeypairStore("node");

    if (storedKey) {
        return storedKey;
    }

    const keyPair = await crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256",
        },
        false,
        ["sign", "verify"],
    );

    await saveKeypairStore("node", keyPair);

    return keyPair;
}

/** A fresh `risu-auth` token for this browser's key. */
async function createAuth() {
    const keyPair = await getKeyPair();
    const date = Math.floor(Date.now() / 1000);

    const header = {
        alg: "ES256",
        typ: "JWT",
    };
    const payload = {
        iat: date,
        exp: date + 5 * 60, //5 minutes expiration
        pub: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
    };
    const sig = await crypto.subtle.sign(
        {
            name: "ECDSA",
            hash: "SHA-256",
        },
        keyPair.privateKey,
        Buffer.from(JSONStringlifyAndbase64Url(header) + "." + JSONStringlifyAndbase64Url(payload)),
    );
    const sigString = base64url(new Uint8Array(sig));
    return JSONStringlifyAndbase64Url(header) + "." + JSONStringlifyAndbase64Url(payload) + "." + sigString;
}

function failedResponseMessage(text: string, fallback: string): string {
    try {
        const body = JSON.parse(text);
        if (typeof body?.error === "string") {
            return body.error;
        }
    } catch {}
    return text || fallback;
}

/** Registers this browser's public key with the password digest; alerts and throws on failure. */
async function login(passwordDigest: string) {
    const keypair = await getKeyPair();
    const publicKey = await crypto.subtle.exportKey("jwk", keypair.publicKey);
    const s = await fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({
            password: passwordDigest,
            publicKey: publicKey,
        }),
        headers: {
            "content-type": "application/json",
        },
    });
    if (s.status < 200 || s.status >= 300) {
        const message = failedResponseMessage(await s.text(), `Login failed (${s.status})`);
        alertError(message);
        await waitAlert();
        throw message;
    }
}

let authChecked = false;
let checking: Promise<unknown> | null = null;

/** One auth check (and password prompt) at a time; parallel requests wait for it. */
async function checkAuth() {
    if (authChecked) {
        return;
    }
    checking ??= runAuthCheck().finally(() => {
        checking = null;
    });
    await checking;
}

async function runAuthCheck() {
    if (!authChecked) {
        const response = await fetch("/api/test_auth", {
            headers: {
                "risu-auth": await createAuth(),
            },
        });
        const text = await response.text();
        let status: unknown;
        try {
            status = JSON.parse(text)?.status;
        } catch {}
        if (!response.ok || (status !== "success" && status !== "unset" && status !== "incorrect")) {
            throw failedResponseMessage(text, `Authentication failed (${response.status})`);
        }

        if (status === "unset") {
            const input = await digestPassword(await alertInput(language.setNodePassword));
            const setup = await fetch("/api/set_password", {
                method: "POST",
                body: JSON.stringify({
                    password: input,
                }),
                headers: {
                    "content-type": "application/json",
                },
            });
            if (!setup.ok) {
                const message = failedResponseMessage(await setup.text(), `Password setup failed (${setup.status})`);
                alertError(message);
                await waitAlert();
                throw message;
            }
            // Register this browser's key with the password just set, so the first request after
            // setup is authorized instead of failing with "Unknown public key".
            await login(input);
            authChecked = true;
            return await createAuth();
        } else if (status === "incorrect") {
            const input = await digestPassword(await alertInput(language.inputNodePassword));
            await login(input);
            authChecked = true;
            return await createAuth();
        } else if (status === "success") {
            authChecked = true;
        }
    }
}

/** Makes sure this browser's key is registered (prompting for the password once if needed). */
export async function ensureAuth() {
    await checkAuth();
}

/** A fresh `risu-auth` token, after the auth check: for a request `authFetch` does not send (a socket URL, the proxy). */
export async function getNodeServerProxyAuth() {
    await checkAuth();
    return await createAuth();
}

/**
 * `fetch` to the self-host server with a fresh `risu-auth` token. `beforeDispatch` runs after the
 * authentication and signing, right before the request goes out; a throw stops it.
 */
export async function authFetch(
    input: string,
    init: RequestInit = {},
    options: { beforeDispatch?: () => void } = {},
): Promise<Response> {
    await ensureAuth();
    const headers = new Headers(init.headers);
    headers.set("risu-auth", await createAuth());
    options.beforeDispatch?.();
    return await fetch(input, { ...init, headers });
}

async function digestPassword(message: string) {
    const response = await fetch("/api/crypto", {
        body: JSON.stringify({
            data: message,
        }),
        headers: {
            "content-type": "application/json",
        },
        method: "POST",
    });

    if (response.status < 200 || response.status >= 300) {
        throw failedResponseMessage(await response.text(), `Password crypto failed (${response.status})`);
    }
    const crypt = await response.text();

    return crypt;
}
