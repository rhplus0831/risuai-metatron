import { language } from "src/lang";
import { alertError, alertInput, waitAlert } from "../alert";
import { base64url, getKeypairStore, saveKeypairStore } from "../util";
import { readWithDeadline } from "./readDeadline";

/**
 * The tab's authentication with the self-host server (split out of the old storage client): one
 * state for every caller (the resource client, the asset client, the proxy, the sockets). This
 * browser has a non-extractable ECDSA P-256 key pair (stored under `"node"`); a request carries a
 * fresh ES256 JWT over its public key (`risu-auth`, valid five minutes). The first check asks the
 * server whether the key is known (`/api/test_auth`): on a fresh server the password is set, then
 * the key registered with it; with an unknown key the password is asked and the key registered. One
 * check runs at a time; parallel callers wait for it, and a failed one is tried again next time.
 */

const AUTH_CHECK_STEP_DEADLINE_MS = 20_000;

function authCheckStep<T>(step: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return readWithDeadline(AUTH_CHECK_STEP_DEADLINE_MS, "The server did not answer the sign-in check in time", step);
}

function JSONStringlifyAndbase64Url(obj: unknown) {
    return base64url(Buffer.from(JSON.stringify(obj), "utf-8"));
}

// A replacement check joins an IndexedDB write that already started, so the writes cannot race.
let savingKeyPair: Promise<CryptoKeyPair> | null = null;

async function getKeyPair(signal?: AbortSignal): Promise<CryptoKeyPair> {
    if (savingKeyPair) {
        return savingKeyPair;
    }
    const storedKey = await getKeypairStore("node");
    signal?.throwIfAborted();

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

    // WebCrypto can finish after the check expires. Only an active step can start a write.
    signal?.throwIfAborted();
    savingKeyPair ??= saveKeypairStore("node", keyPair)
        .then(() => keyPair)
        .finally(() => {
            savingKeyPair = null;
        });
    return savingKeyPair;
}

/** A fresh `risu-auth` token for this browser's key. */
async function createAuth(signal?: AbortSignal) {
    const keyPair = await getKeyPair(signal);
    signal?.throwIfAborted();
    const date = Math.floor(Date.now() / 1000);

    const header = {
        alg: "ES256",
        typ: "JWT",
    };
    const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    signal?.throwIfAborted();
    const payload = {
        iat: date,
        exp: date + 5 * 60, //5 minutes expiration
        pub: publicKey,
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
    const token = JSONStringlifyAndbase64Url(header) + "." + JSONStringlifyAndbase64Url(payload) + "." + sigString;
    return { token, publicKey };
}

function failedResponseMessage(text: string, fallback: () => string): string {
    try {
        const body = JSON.parse(text);
        if (typeof body?.error === "string") {
            return body.error;
        }
    } catch {}
    return text || fallback();
}

/** Bounds both halves of the answer before the check uses it or shows a prompt. */
function readAuthAnswer(path: string, init?: RequestInit) {
    return authCheckStep(async (signal) => {
        const response = await fetch(path, { ...init, signal });
        signal.throwIfAborted();
        const text = await response.text();
        return { response, text };
    });
}

/** Registers the public key used in the check; alerts and throws on failure. */
async function login(passwordDigest: string, publicKey: JsonWebKey) {
    const { response, text } = await readAuthAnswer("/api/login", {
        method: "POST",
        body: JSON.stringify({
            password: passwordDigest,
            publicKey: publicKey,
        }),
        headers: {
            "content-type": "application/json",
        },
    });
    if (!response.ok) {
        const message = failedResponseMessage(text, () => language.serverAuth.loginFailed(response.status));
        alertError(message);
        await waitAlert();
        throw message;
    }
}

let authChecked = false;
let checking: Promise<void> | null = null;

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
    const { token, publicKey } = await authCheckStep(createAuth);
    const { response, text } = await readAuthAnswer("/api/test_auth", { headers: { "risu-auth": token } });
    let status: unknown;
    try {
        status = JSON.parse(text)?.status;
    } catch {}
    if (!response.ok || (status !== "success" && status !== "unset" && status !== "incorrect")) {
        throw failedResponseMessage(text, () => language.serverAuth.authenticationFailed(response.status));
    }

    if (status === "unset" || status === "incorrect") {
        const prompt = status === "unset" ? language.setNodePassword : language.inputNodePassword;
        const input = await digestPassword(await alertInput(prompt, undefined, undefined, { secret: true }));
        if (status === "unset") {
            await setPassword(input);
        }
        await login(input, publicKey);
    }
    authChecked = true;
}

/** Makes sure this browser's key is registered (prompting for the password once if needed). */
export async function ensureAuth() {
    await checkAuth();
}

/** A fresh `risu-auth` token, after the auth check: for a request `authFetch` does not send (a socket URL, the proxy). */
export async function getNodeServerProxyAuth() {
    await checkAuth();
    return (await createAuth()).token;
}

/** Races one caller's wait against its signal; shared authentication and signing continue independently. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) {
        return work;
    }
    return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) {
            aborted();
            // The work may already have started; its rejection still needs an observer.
            void work.catch(() => {});
            return;
        }
        signal.addEventListener("abort", aborted, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
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
    init.signal?.throwIfAborted();
    await abortable(ensureAuth(), init.signal);
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("risu-auth", (await abortable(createAuth(), init.signal)).token);
    init.signal?.throwIfAborted();
    options.beforeDispatch?.();
    return await fetch(input, { ...init, headers });
}

async function digestPassword(message: string) {
    const { response, text } = await readAuthAnswer("/api/crypto", {
        body: JSON.stringify({
            data: message,
        }),
        headers: {
            "content-type": "application/json",
        },
        method: "POST",
    });

    if (!response.ok) {
        throw failedResponseMessage(text, () => language.serverAuth.passwordCryptoFailed(response.status));
    }
    return text;
}

async function setPassword(password: string) {
    const { response, text } = await readAuthAnswer("/api/set_password", {
        method: "POST",
        body: JSON.stringify({ password }),
        headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
        const message = failedResponseMessage(text, () => language.serverAuth.passwordSetupFailed(response.status));
        alertError(message);
        await waitAlert();
        throw message;
    }
}
