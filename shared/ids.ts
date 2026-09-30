/**
 * A random v4 UUID for record ids assigned at creation (presets, personas, translator and HypaV3
 * presets). Built on `crypto.getRandomValues`, which exists in Node and in every browser context;
 * `crypto.randomUUID` does not, because it needs a secure context and the self-host client may be
 * served over plain HTTP on a LAN address.
 */
export function newId(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether `value` can serve as a record id: a non-empty string. */
export function isRecordId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}
