/**
 * Server-sent event framing for the MCP clients (the server's `server/src/mcp/client.ts` and the
 * tab's `src/ts/process/mcp/mcplib.ts`; Phase 5 Stop D fixes). Bytes go in as they arrive; each
 * complete event comes out as its text. Line ends are CRLF, LF, or CR (a CR ends its line at once;
 * an LF first in the next non-empty chunk is taken as the rest of that CRLF). An event ends at a
 * blank line; an unfinished event at the end of the stream is dropped. Dispatch (endpoint, ping, answers) stays in each client.
 */

const LF = 10;
const CR = 13;

/** A parsed event: its `event` field ("" when absent) and its `data` lines joined with "\n". */
export type SseEvent = { event: string; data: string };

/**
 * Splits a byte stream into events. `onEvent` gets each event's text (its lines with their line
 * ends as they came, without the line end of its last line and the blank line). `maxEventBytes`
 * bounds an event's bytes as counted in that text; a larger one throws from `push` (the events
 * before it in the same chunk were already delivered).
 */
export class SseFramer {
    private readonly decoder = new TextDecoder("utf-8");
    /** The current event's bytes so far (without the line end of its last finished line). */
    private parts: Uint8Array[] = [];
    private size = 0;
    /** The line end after the event's last finished line: written into the event when another line follows. */
    private ending: Uint8Array | null = null;
    /** Whether the current line has no bytes yet (a line end now is a blank line). */
    private lineEmpty = true;
    /** The previous chunk ended with a CR: an LF first in this chunk belongs to that line end. */
    private afterCR = false;

    private readonly onEvent: (text: string) => void;
    private readonly maxEventBytes: number;

    constructor(onEvent: (text: string) => void, maxEventBytes = Number.POSITIVE_INFINITY) {
        this.onEvent = onEvent;
        this.maxEventBytes = maxEventBytes;
    }

    push(chunk: Uint8Array): void {
        // An empty chunk changes nothing (a pending CR still pairs with an LF in the next chunk).
        if (chunk.length === 0) {
            return;
        }
        let pos = 0;
        if (this.afterCR) {
            this.afterCR = false;
            if (chunk[0] === LF) {
                if (this.ending) {
                    this.ending = Uint8Array.of(CR, LF);
                }
                pos = 1;
            }
        }
        let nextLF = -2;
        let nextCR = -2;
        while (pos < chunk.length) {
            if (nextLF !== -1 && nextLF < pos) {
                nextLF = chunk.indexOf(LF, pos);
            }
            if (nextCR !== -1 && nextCR < pos) {
                nextCR = chunk.indexOf(CR, pos);
            }
            const end = nextLF === -1 ? nextCR : nextCR === -1 ? nextLF : Math.min(nextLF, nextCR);
            const stop = end === -1 ? chunk.length : end;
            if (stop > pos) {
                this.append(chunk.subarray(pos, stop));
            }
            if (end === -1) {
                return;
            }
            let after = end + 1;
            let ending: Uint8Array;
            if (chunk[end] === CR) {
                if (after < chunk.length) {
                    if (chunk[after] === LF) {
                        after += 1;
                        ending = Uint8Array.of(CR, LF);
                    } else {
                        ending = Uint8Array.of(CR);
                    }
                } else {
                    this.afterCR = true;
                    ending = Uint8Array.of(CR);
                }
            } else {
                ending = Uint8Array.of(LF);
            }
            this.lineEnd(ending);
            pos = after;
        }
    }

    private append(bytes: Uint8Array) {
        if (this.ending) {
            this.parts.push(this.ending);
            this.size += this.ending.length;
            this.ending = null;
        }
        this.parts.push(bytes.slice());
        this.size += bytes.length;
        this.lineEmpty = false;
        if (this.size > this.maxEventBytes) {
            throw new Error("An MCP event is too large");
        }
    }

    private lineEnd(ending: Uint8Array) {
        if (!this.lineEmpty) {
            this.ending = ending;
            this.lineEmpty = true;
            return;
        }
        // A blank line: the event so far is complete (blank lines before an event are skipped).
        if (this.parts.length > 0) {
            const event = new Uint8Array(this.size);
            let offset = 0;
            for (const part of this.parts) {
                event.set(part, offset);
                offset += part.length;
            }
            this.parts = [];
            this.size = 0;
            this.ending = null;
            this.onEvent(this.decoder.decode(event));
        }
    }
}

/**
 * Reads an event's fields: a line is `field: value` (the colon, then at most one space removed), a
 * line starting with a colon is a comment, and a line without a colon is a field with no value.
 * `data` lines are joined with "\n"; the last `event` field wins.
 */
export function parseSseEvent(text: string): SseEvent {
    const data: string[] = [];
    let event = "";
    for (const line of text.split(/\r\n|\r|\n/)) {
        if (line === "" || line.startsWith(":")) {
            continue;
        }
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
            value = value.slice(1);
        }
        if (field === "data") {
            data.push(value);
        } else if (field === "event") {
            event = value;
        }
    }
    return { event, data: data.join("\n") };
}
