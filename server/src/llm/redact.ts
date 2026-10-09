import type { RequestDb } from "./settings.ts";

/**
 * The secret-free projection of what a request sends back to the client (`request-layer-and-llm-secrets`):
 * logs, notices, errors, fail results, previews, callback payloads, and tool records. Never applied
 * to the request sent upstream.
 *
 * - Every credential value of the request (the `llmSecrets` keys, `google.accessToken`,
 *   `hordeConfig.apiKey`, `novelai.token`, `vertexPrivateKey`, `vertexAccessToken`, each
 *   `OaiCompAPIKeys` value, every named credential's key and client email, the parts of a
 *   Bedrock `accessKeyId:secretAccessKey:region` credential, and each Vertex token handed out) is
 *   replaced by `[redacted]` wherever it occurs in a string, also in its JSON-escaped and
 *   URL-encoded forms; every non-empty value, however short. The readable siblings (`google.projectId`, `hordeConfig.model`, `hordeConfig.softPrompt`,
 *   `novelai.model`, `vertexClientEmail`) are not credentials.
 * - By name: the values of the `authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, `apikey`,
 *   and `x-api-key` headers in a log entry's headers, and the `key`, `api_key`, and `token` query
 *   parameters of any URL-looking string.
 *
 * A free-form `header::` value in `additionalParams` or a custom model's `params` that is not a
 * stored credential is user configuration, outside this guarantee (owner answer 3).
 */
export const REDACTED = "[redacted]";

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key", "apikey"]);
const SECRET_QUERY = /([?&](?:key|api_key|token)=)[^&#\s"'\\]*/gi;

const STRING_SECRET_FIELDS = [
    "openAIKey",
    "claudeAPIKey",
    "openrouterKey",
    "nanogptKey",
    "mistralKey",
    "cohereAPIKey",
    "ollamaApiKey",
    "novellistAPI",
    "mancerHeader",
    "supaMemoryKey",
    "vertexPrivateKey",
    "vertexAccessToken",
] as const;

export type Redactor = {
    /** Adds a value to redact from now on (a refreshed token). */
    add(secret: string | null | undefined): void;
    /** A deep copy of `value` with every secret replaced. */
    apply<T>(value: T): T;
    text(value: string): string;
    /**
     * Whether a stored credential (in any of its forms) occurs in `value`: in a string, or in an
     * object's property name, at any depth. For content the tab must get unaltered (a callback
     * payload, a tool record, a body for an interceptor), which is refused rather than redacted.
     */
    carries(value: unknown): boolean;
};

export function collectSecrets(db: Partial<RequestDb>): string[] {
    const secrets: string[] = [];
    const record = db as Record<string, unknown>;
    for (const field of STRING_SECRET_FIELDS) {
        const value = record[field];
        if (typeof value === "string") {
            secrets.push(value);
        }
    }
    const google = db.google as { accessToken?: unknown } | undefined;
    if (typeof google?.accessToken === "string") {
        secrets.push(google.accessToken);
    }
    const horde = db.hordeConfig as { apiKey?: unknown } | undefined;
    if (typeof horde?.apiKey === "string") {
        secrets.push(horde.apiKey);
    }
    const novelai = db.novelai as { token?: unknown } | undefined;
    if (typeof novelai?.token === "string") {
        secrets.push(novelai.token);
    }
    if (db.OaiCompAPIKeys && typeof db.OaiCompAPIKeys === "object") {
        for (const value of Object.values(db.OaiCompAPIKeys)) {
            if (typeof value === "string") {
                secrets.push(value);
            }
        }
    }
    for (const credential of Object.values(db.credentials ?? {})) {
        if (typeof credential?.key === "string") {
            secrets.push(credential.key, ...credential.key.split(":"));
        }
        if (typeof credential?.clientEmail === "string") {
            secrets.push(credential.clientEmail);
        }
    }
    if (typeof db.claudeAPIKey === "string") {
        // Bedrock splits the Claude key into `accessKeyId:secretAccessKey:region` (`anthropic.ts`).
        secrets.push(...db.claudeAPIKey.split(":"));
    }
    return secrets;
}

function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(initial: string[]): Redactor {
    const forms = new Set<string>();
    let pattern: RegExp | null = null;

    function add(secret: string | null | undefined) {
        if (typeof secret !== "string" || secret === "") {
            return;
        }
        const before = forms.size;
        forms.add(secret);
        forms.add(JSON.stringify(secret).slice(1, -1));
        forms.add(JSON.stringify(JSON.stringify(secret)).slice(3, -3));
        forms.add(encodeURIComponent(secret));
        if (forms.size !== before) {
            // Longest first, so a secret containing another is replaced whole.
            const sorted = [...forms].filter((form) => form !== "").sort((a, b) => b.length - a.length);
            pattern = new RegExp(sorted.map(escapeRegExp).join("|"), "g");
        }
    }

    function text(value: string): string {
        let out = pattern ? value.replace(pattern, REDACTED) : value;
        out = out.replace(SECRET_QUERY, `$1${REDACTED}`);
        return out;
    }

    function contains(text: string): boolean {
        if (!pattern) {
            return false;
        }
        pattern.lastIndex = 0;
        return pattern.test(text);
    }

    function carries(value: unknown): boolean {
        if (typeof value === "string") {
            return contains(value);
        }
        if (Array.isArray(value)) {
            return value.some(carries);
        }
        if (value && typeof value === "object") {
            return Object.entries(value).some(([key, entry]) => contains(key) || carries(entry));
        }
        return false;
    }

    function walk(value: unknown, key?: string): unknown {
        if (typeof value === "string") {
            if (key !== undefined && SECRET_HEADERS.has(key.toLowerCase()) && value !== "") {
                return REDACTED;
            }
            return text(value);
        }
        if (Array.isArray(value)) {
            return value.map((entry) => walk(entry));
        }
        if (value && typeof value === "object") {
            const out: Record<string, unknown> = {};
            for (const [entryKey, entry] of Object.entries(value)) {
                out[entryKey] = walk(entry, entryKey);
            }
            return out;
        }
        return value;
    }

    for (const secret of initial) {
        add(secret);
    }

    return {
        add,
        apply: <T>(value: T) => walk(value) as T,
        text,
        carries,
    };
}

/**
 * A log entry's `header` is the JSON text of the request headers: the named headers are masked
 * inside it before the value redaction runs.
 */
export function redactHeaderText(header: string): string {
    try {
        const parsed = JSON.parse(header);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return header;
        }
        let changed = false;
        for (const name of Object.keys(parsed)) {
            if (SECRET_HEADERS.has(name.toLowerCase()) && typeof parsed[name] === "string" && parsed[name] !== "") {
                parsed[name] = REDACTED;
                changed = true;
            }
        }
        return changed ? JSON.stringify(parsed, null, 2) : header;
    } catch {
        return header;
    }
}
