/**
 * The batch asset codec (historical `docs/plan/large-asset-import.md` slice 1b): the local backup archive's
 * record framing (`server/src/data/archive.ts`), each record `u32le nameLength`, the UTF-8 name,
 * `u32le dataLength`, then the bytes, with no header or footer of its own.
 *
 * - `POST /api/assets/write` takes records named by their full logical keys (`assets/<id>.<ext>`)
 *   and writes each one under its key (always overwriting, as `/api/write` does).
 * - `POST /api/assets/read` takes a JSON `{ keys }` list and answers one record per key, in the order
 *   asked: the stored bytes, or a zero-length record when there are none.
 *
 * The routes are `server/src/routes/storage.ts`; the client is `src/ts/storage/assetClient.ts`.
 * The encoder and the parser run in both: `TextEncoder`/`TextDecoder` and `DataView` only.
 */

export const ASSET_BATCH_WRITE_PATH = "/api/assets/write";
export const ASSET_BATCH_READ_PATH = "/api/assets/read";
/** Most records one batch may carry (a write) or ask for (a read). */
export const MAX_ASSET_BATCH_RECORDS = 2000;
/** Most UTF-8 bytes of one record name, the backup archive's cap. */
export const MAX_ASSET_BATCH_NAME_BYTES = 4096;
/** Most bytes of one record: its length is a `u32le`. */
export const MAX_ASSET_RECORD_BYTES = 0xffffffff;

/** A batch that does not follow the framing, or a record that cannot be framed. */
export class AssetBatchFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AssetBatchFormatError";
    }
}

/** One whole record. */
export type AssetRecord = { name: string; bytes: Uint8Array };

/**
 * One step of a record as `AssetRecordParser.events` reads it: `start` once its header is complete,
 * `data` for each piece of its bytes as they arrive (none for a zero-length record), `end` once it is
 * complete. `index` counts records from 0.
 */
export type AssetRecordEvent =
    | { type: "start"; index: number; name: string; length: number }
    | { type: "data"; index: number; bytes: Uint8Array }
    | { type: "end"; index: number };

const encoder = new TextEncoder();

/**
 * A record header: `u32le nameLength`, the UTF-8 name, `u32le dataLength`; the record's bytes follow
 * it. Throws `AssetBatchFormatError` for a name the parser would refuse (empty, or over
 * `MAX_ASSET_BATCH_NAME_BYTES`) and for a length that is not a `u32`.
 */
export function encodeAssetRecordHeader(name: string, length: number): Uint8Array {
    const nameBytes = encoder.encode(name);
    if (nameBytes.length === 0 || nameBytes.length > MAX_ASSET_BATCH_NAME_BYTES) {
        throw new AssetBatchFormatError(`Asset record ${name} has an invalid name`);
    }
    if (!Number.isInteger(length) || length < 0 || length > MAX_ASSET_RECORD_BYTES) {
        throw new AssetBatchFormatError(`Asset record ${name} is too large`);
    }
    const header = new Uint8Array(8 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, nameBytes.length, true);
    header.set(nameBytes, 4);
    view.setUint32(4 + nameBytes.length, length, true);
    return header;
}

/**
 * Reads a batch incrementally, in chunks of any size. Two ways, one per parser:
 *
 * - `push(chunk)` returns the records the chunk completes, each record's bytes collected in one
 *   array of its declared length.
 * - `events(chunk)` yields `AssetRecordEvent`s; a `data` event is a view into `chunk`, so a streaming
 *   consumer gets a record's bytes without the parser holding them. The events are produced as the
 *   consumer iterates, so everything before a format error is delivered before it throws.
 *
 * `end()` checks the batch ended on a record boundary. Every refusal is an `AssetBatchFormatError`:
 * a zero-length name, a name over `MAX_ASSET_BATCH_NAME_BYTES` or not strict UTF-8, a record past
 * `MAX_ASSET_BATCH_RECORDS`, or a trailing partial record. A parser that threw, or whose `events`
 * iteration was left before its end, must not be used again.
 */
export class AssetRecordParser {
    // `ignoreBOM` keeps a leading U+FEFF in the name, so the decoded name encodes back to its bytes.
    private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    /** The `u32le` field being read: a name length or a data length. */
    private readonly word = new Uint8Array(4);
    private readonly wordView = new DataView(this.word.buffer);
    private wordFilled = 0;
    private readonly nameBuffer = new Uint8Array(MAX_ASSET_BATCH_NAME_BYTES);
    private nameLength = 0;
    private nameFilled = 0;
    private name = "";
    /** What the next bytes belong to. */
    private phase: "nameLength" | "name" | "dataLength" | "data" = "nameLength";
    /** Bytes of the current record still to come. */
    private remaining = 0;
    /** Records whose header is complete; the current record's index is `started - 1`. */
    private started = 0;
    /** The record `push` is collecting. */
    private collecting: { name: string; bytes: Uint8Array; filled: number } | null = null;

    /** Every record completed by `chunk`, in order (records completed earlier in a chunk that throws are lost). */
    push(chunk: Uint8Array): AssetRecord[] {
        const records: AssetRecord[] = [];
        for (const event of this.events(chunk)) {
            if (event.type === "start") {
                this.collecting = { name: event.name, bytes: new Uint8Array(event.length), filled: 0 };
                continue;
            }
            const current = this.collecting!;
            if (event.type === "data") {
                current.bytes.set(event.bytes, current.filled);
                current.filled += event.bytes.length;
            } else {
                records.push({ name: current.name, bytes: current.bytes });
                this.collecting = null;
            }
        }
        return records;
    }

    /** The events of `chunk`, in order. */
    *events(chunk: Uint8Array): Generator<AssetRecordEvent, void, undefined> {
        let at = 0;
        while (at < chunk.length) {
            if (this.phase === "data") {
                const take = Math.min(this.remaining, chunk.length - at);
                const bytes = chunk.subarray(at, at + take);
                at += take;
                this.remaining -= take;
                const index = this.started - 1;
                const finished = this.remaining === 0;
                if (finished) {
                    this.phase = "nameLength";
                }
                yield { type: "data", index, bytes };
                if (finished) {
                    yield { type: "end", index };
                }
                continue;
            }
            if (this.phase === "name") {
                const take = Math.min(this.nameLength - this.nameFilled, chunk.length - at);
                this.nameBuffer.set(chunk.subarray(at, at + take), this.nameFilled);
                this.nameFilled += take;
                at += take;
                if (this.nameFilled === this.nameLength) {
                    try {
                        this.name = this.decoder.decode(this.nameBuffer.subarray(0, this.nameLength));
                    } catch {
                        throw new AssetBatchFormatError("An asset record name is not UTF-8");
                    }
                    this.phase = "dataLength";
                }
                continue;
            }
            if (this.phase === "nameLength" && this.wordFilled === 0 && this.started >= MAX_ASSET_BATCH_RECORDS) {
                throw new AssetBatchFormatError(`An asset batch holds more than ${MAX_ASSET_BATCH_RECORDS} records`);
            }
            const take = Math.min(4 - this.wordFilled, chunk.length - at);
            this.word.set(chunk.subarray(at, at + take), this.wordFilled);
            this.wordFilled += take;
            at += take;
            if (this.wordFilled < 4) {
                continue;
            }
            this.wordFilled = 0;
            const value = this.wordView.getUint32(0, true);
            if (this.phase === "nameLength") {
                if (value === 0 || value > MAX_ASSET_BATCH_NAME_BYTES) {
                    throw new AssetBatchFormatError("An asset record has an invalid name length");
                }
                this.nameLength = value;
                this.nameFilled = 0;
                this.phase = "name";
                continue;
            }
            const index = this.started;
            this.started += 1;
            this.remaining = value;
            this.phase = value === 0 ? "nameLength" : "data";
            yield { type: "start", index, name: this.name, length: value };
            if (value === 0) {
                yield { type: "end", index };
            }
        }
    }

    /** Throws `AssetBatchFormatError` when the bytes so far end inside a record. */
    end(): void {
        if (this.phase !== "nameLength" || this.wordFilled !== 0) {
            throw new AssetBatchFormatError("The asset batch is truncated");
        }
    }
}
