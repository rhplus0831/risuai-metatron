import type { RequestDb } from "./settings.ts";

/**
 * The secret-free projection of what a request sends back to the client: logs, notices, errors,
 * fail results, previews, callback payloads, and tool records. Never applied to the request sent
 * upstream.
 *
 * - Every credential value of the request (the `llmSecrets` keys, `google.accessToken`,
 *   `hordeConfig.apiKey`, `novelai.token`, `vertexPrivateKey`, `vertexAccessToken`, each
 *   `OaiCompAPIKeys` value, every named credential's key and client email, the parts of a
 *   Bedrock `accessKeyId:secretAccessKey:region` credential, and each Vertex token handed out) is
 *   replaced by `[redacted]` wherever it occurs in a string, also in its JSON-escaped and
 *   URL-encoded forms; every non-empty value, however short. The readable siblings (`google.projectId`,
 *   `hordeConfig.model`, `hordeConfig.softPrompt`, `novelai.model`, `vertexClientEmail`) are not credentials.
 * - By name: the values of the `authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, and `apikey`
 *   headers in a log entry's headers, and the `key`, `api_key`, and `token` query parameters of any URL-looking string.
 *
 * A free-form `header::` value in `additionalParams` or a custom model's `params` that is not a
 * stored credential is user configuration, outside this guarantee.
 *
 * `server/src/llm/requests.ts` applies this projection to request data, leaving generated answers unchanged. Secret
 * forms include twice-JSON-escaped values and match longest first, ignoring percent-escape hex case.
 * Deep projection masks string-valued secret headers
 * by name and retains object keys; `carries` checks stored secret forms in both keys and values so callers can refuse
 * opaque callback/tool data rather than rewrite it. `trimPartial` removes a trailing secret prefix from bounded
 * captures after full-value redaction.
 */

/** Replacement text for a masked credential or named secret field. */
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

/** Per-request secret matching and deep string-value projection; `add` extends all later matching immediately. */
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
    /**
     * `value` without a trailing start of a secret form: for a text cut at a bound (a captured stream
     * body), where a credential cut in two would otherwise leave its first part. Run after `text`.
     */
    trimPartial(value: string): string;
};

/**
 * Collects stored provider credentials, compatibility keys, and named keys/client emails, including colon-separated
 * key components. Returns duplicates and empty strings unchanged; `createRedactor` deduplicates forms and ignores empties.
 */
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

function secretPattern(text: string) {
    return text
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%[0-9a-f]{2}/gi, (escape) =>
            escape.replace(/[a-f]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`),
        );
}

function normalizePercentEscapes(text: string): string {
    return text.replace(/%[0-9a-f]{2}|%[0-9a-f]$/gi, (escape) => escape.toUpperCase());
}

/**
 * Builds a mutable secret matcher. `text` also masks named query values; `apply` copies JSON-like arrays/objects and
 * masks string values and secret headers without rewriting keys. `carries` checks stored secret forms in values and
 * keys, not the header/query-name rules. Cyclic inputs are not handled by either recursive traversal.
 */
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
            pattern = new RegExp(sorted.map(secretPattern).join("|"), "g");
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

    function trimPartial(value: string): string {
        let cut = value.length;
        const normalized = normalizePercentEscapes(value);
        for (const stored of forms) {
            const form = normalizePercentEscapes(stored);
            if (form.length < 2) {
                continue;
            }
            // A proper prefix of the form that ends the text (the whole form is already replaced).
            for (let i = Math.max(0, value.length - (form.length - 1)); i < cut; i++) {
                // A hex digit inside a percent escape is not a secret's first letter (`%a` is an unmatched escape).
                if (normalized[i - 1] === "%" || (normalized[i - 2] === "%" && /[0-9A-F]/.test(normalized[i - 1]))) {
                    continue;
                }
                if (normalized.charCodeAt(i) === form.charCodeAt(0) && form.startsWith(normalized.slice(i))) {
                    cut = i;
                    break;
                }
            }
        }
        return value.slice(0, cut);
    }

    for (const secret of initial) {
        add(secret);
    }

    return {
        add,
        apply: <T>(value: T) => walk(value) as T,
        text,
        carries,
        trimPartial,
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
