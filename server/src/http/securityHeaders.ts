/** Sandbox untrusted asset and hub documents with an opaque origin and no scripts. */
export const UNTRUSTED_CONTENT_CSP =
    "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
