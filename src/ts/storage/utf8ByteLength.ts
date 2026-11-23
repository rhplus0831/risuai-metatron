/** Counts the UTF-8 bytes fetch sends for a string without allocating an encoded copy. */
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.codePointAt(index)!;
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code <= 0xffff) {
            // An unpaired surrogate is encoded as the three-byte replacement character.
            bytes += 3;
        } else {
            bytes += 4;
            index += 1;
        }
    }
    return bytes;
}
