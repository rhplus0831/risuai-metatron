/** Replacement text for a masked credential or named secret field. */
export const REDACTED = "[redacted]";

/** Header names shared by server history and the tab's request log. */
export const SECRET_HEADERS: ReadonlySet<string> = new Set([
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
    "api-key",
    "apikey",
    "xi-api-key",
    "cookie",
    "set-cookie",
]);

/** Masks named credentials in the JSON text of a log entry's request headers. */
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

const SECRET_BODY_FIELDS = new Set([
    "access_token",
    "refresh_token",
    "client_secret",
    "id_token",
    "code_verifier",
    "token",
]);

function redactFormText(body: string): string {
    return body.replace(/(^|&)([^=&]+)=([^&]*)/g, (field, prefix: string, name: string) => {
        try {
            const decodedName = decodeURIComponent(name.replace(/\+/g, " ")).toLowerCase();
            if (
                SECRET_BODY_FIELDS.has(decodedName) ||
                (decodedName === "code" && new URLSearchParams(body).get("grant_type") === "authorization_code")
            ) {
                return `${prefix}${name}=${encodeURIComponent(REDACTED)}`;
            }
        } catch {
            // Malformed form names are not OAuth field names.
        }
        return field;
    });
}

/** Masks OAuth credentials in serialized JSON or form bodies, preserving other log text. */
export function redactBodyText(body: string): string {
    if (typeof body !== "string" || body === "") {
        return body;
    }
    try {
        let changed = false;
        const parsed = JSON.parse(body, function (key, value) {
            if (
                SECRET_BODY_FIELDS.has(key.toLowerCase()) ||
                (key.toLowerCase() === "code" && this?.grant_type === "authorization_code")
            ) {
                changed = true;
                return value === "" || value === null ? value : REDACTED;
            }
            if (typeof value === "string") {
                const redacted = redactBodyText(value);
                changed ||= redacted !== value;
                return redacted;
            }
            return value;
        });
        return changed ? JSON.stringify(parsed, null, 2) : body;
    } catch {
        return redactFormText(body);
    }
}
