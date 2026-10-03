// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSseEvent, SseFramer } from "../../../shared/mcp/sse.ts";

// Phase 5 Stop D fixes (slice 13d): the event framing both MCP clients share (`shared/mcp/sse.ts`),
// on its own. `SseFramer`: CRLF, LF, and CR line ends (a CR at a chunk end ends its line at once and
// an LF first in the next non-empty chunk completes it), an empty chunk changing nothing, UTF-8 and
// line ends split at every byte position, blank lines before an event, several events in a chunk, an
// unfinished tail never delivered, and the byte bound (the event's text, its internal line ends
// included and the pending line end excluded; an event before an oversized one is still delivered).
// `parseSseEvent`: the colon with at most one space removed, comments, multiline data, a field
// without a colon, unknown fields, and the last `event` field. The clients' own readers are tested
// with their dispatch: `mcp.test.ts` (the server) and `src/ts/process/mcp/tests/mcplib.test.ts`.

const enc = new TextEncoder();
const bytes = (text: string) => enc.encode(text);

/** Frames `chunks` and returns the delivered texts, and the error `push` threw, if any. */
function frame(chunks: (string | Uint8Array)[], maxEventBytes?: number) {
    const events: string[] = [];
    const framer = new SseFramer((event) => events.push(event), maxEventBytes);
    let error: unknown = null;
    try {
        for (const chunk of chunks) {
            framer.push(typeof chunk === "string" ? bytes(chunk) : chunk);
        }
    } catch (caught) {
        error = caught;
    }
    return { events, error };
}

/** `whole` cut at the byte positions `cuts` (ascending), with an empty chunk after each piece when `empties`. */
function cutAt(whole: Uint8Array, cuts: number[], empties: boolean) {
    const chunks: Uint8Array[] = [];
    let start = 0;
    for (const cut of [...cuts, whole.length]) {
        chunks.push(whole.subarray(start, cut));
        if (empties) {
            chunks.push(new Uint8Array(0));
        }
        start = cut;
    }
    return chunks;
}

describe("SseFramer", () => {
    const endings = { LF: "\n", CRLF: "\r\n", CR: "\r" } as const;

    for (const [label, end] of Object.entries(endings)) {
        it(`frames ${label} events the same at every pair of cut positions, with and without empty chunks, at the exact byte bound`, () => {
            // An event with a field, a four-byte character, and two data lines; then a second event.
            const first = `event:message${end}data:\u{1F600}x${end}data: y`;
            const second = `data:z`;
            const whole = bytes(`${end}${first}${end}${end}${second}${end}${end}`);
            const bound = enc.encode(first).length;
            let cases = 0;
            for (let i = 0; i <= whole.length; i++) {
                for (let j = i; j <= whole.length; j++) {
                    for (const empties of [false, true]) {
                        const { events, error } = frame(cutAt(whole, [i, j], empties), bound);
                        expect(error).toBeNull();
                        expect(events).toEqual([first, second]);
                        cases++;
                    }
                }
            }
            expect(cases).toBeGreaterThan(1000);
            expect(parseSseEvent(first)).toEqual({ event: "message", data: "\u{1F600}x\ny" });
            // One byte less than the event and it is refused.
            expect(String(frame([whole], bound - 1).error)).toContain("An MCP event is too large");
        });
    }

    it("treats a CRLF split by empty chunks as one line end (an empty chunk changes nothing)", () => {
        expect(frame(["data:x\r", "", "", "\ndata:y\r\n\r\n"]).events).toEqual(["data:x\r\ndata:y"]);
        expect(frame(["data:x\r\n\r", "", "\ndata:y\n\n"]).events).toEqual(["data:x", "data:y"]);
        expect(frame(["", "data:x\n", "", "\n"]).events).toEqual(["data:x"]);
    });

    it("ends a line at a CR at once: a CR blank line at the end of the stream delivers the event; a lone CR does not", () => {
        expect(frame(["data:x\r\r"]).events).toEqual(["data:x"]);
        expect(frame(["data:x\r", "\r"]).events).toEqual(["data:x"]);
        expect(frame(["data:x\r"]).events).toEqual([]);
        // An LF that is not first in the next chunk is a line end of its own.
        expect(frame(["data:x\r", "a\n\n"]).events).toEqual(["data:x\ra"]);
    });

    it("keeps each line's own end inside the event, mixed ends included", () => {
        expect(frame(["data:a\r\ndata:b\ndata:c\rdata:d\n\r\n"]).events).toEqual(["data:a\r\ndata:b\ndata:c\rdata:d"]);
        expect(parseSseEvent("data:a\r\ndata:b\ndata:c\rdata:d").data).toBe("a\nb\nc\nd");
    });

    it("skips blank lines before an event, delivers several events of one chunk in order, and never delivers an unfinished tail", () => {
        expect(
            frame(["\n\r\n\r\n\ndata:1\n\n: comment\ndata:2\n\n\n\ndata:3\r\n\r\ndata:unfinished\n"]).events,
        ).toEqual(["data:1", ": comment\ndata:2", "data:3"]);
        expect(frame(["data:a\n", "data:b"]).events).toEqual([]);
    });

    it("counts the event's text against the bound: internal line ends in, the pending line end and the blank line out", () => {
        const max = 16;
        const exact = "x".repeat(max);
        // The pending line end (the CR, then its LF in the next chunk) is not counted.
        expect(frame([exact + "\r", "\n", "\r\n"], max)).toEqual({ events: [exact], error: null });
        expect(frame([exact, "\n", "\n"], max)).toEqual({ events: [exact], error: null });
        // A line end counts once another line follows it.
        const twoLines = frame(["x".repeat(max - 2) + "\r\n", "y"], max);
        expect(String(twoLines.error)).toContain("too large");
        const fits = frame(["x".repeat(max - 3) + "\r\ny\n\n"], max);
        expect(fits).toEqual({ events: ["x".repeat(max - 3) + "\r\ny"], error: null });
        // An unfinished line over the bound is refused before its line end arrives.
        expect(String(frame(["x".repeat(max + 1)], max).error)).toContain("too large");
    });

    it("delivers an event before an oversized one in the same chunk, and frames many small events in a chunk larger than the bound", () => {
        const { events, error } = frame(["data:x\n\ndata:" + "y".repeat(20) + "\n\n"], 10);
        expect(events).toEqual(["data:x"]);
        expect(String(error)).toContain("too large");

        const many = "data:x\n\n".repeat(80_000);
        const started = Date.now();
        const small = frame([many], 16);
        expect(small.error).toBeNull();
        expect(small.events).toHaveLength(80_000);
        // Linear in the chunk: no rescanning of what was already framed.
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it("decodes an event whole, so a multibyte character split across chunks after a line end is intact", () => {
        const whole = bytes("data:a\n\u{1F600}é\n\n");
        for (let cut = 0; cut <= whole.length; cut++) {
            expect(frame([whole.subarray(0, cut), whole.subarray(cut)]).events).toEqual(["data:a\n\u{1F600}é"]);
        }
    });
});

describe("parseSseEvent", () => {
    it("removes at most one space after the colon and keeps the rest of the value, colons included", () => {
        expect(parseSseEvent("data:x").data).toBe("x");
        expect(parseSseEvent("data: x").data).toBe("x");
        expect(parseSseEvent("data:  x").data).toBe(" x");
        expect(parseSseEvent('data: {"a":"b:c"}').data).toBe('{"a":"b:c"}');
        expect(parseSseEvent("event:endpoint\ndata:/messages?s=1")).toEqual({
            event: "endpoint",
            data: "/messages?s=1",
        });
    });

    it("joins data lines with LF, skips comments and unknown fields, reads a field without a colon as empty, and keeps the last event", () => {
        expect(parseSseEvent(": hi\nid: 7\nretry: 10\ndata: a\ndata\ndata:b\nevent: one\nevent:two")).toEqual({
            event: "two",
            data: "a\n\nb",
        });
        expect(parseSseEvent(": only a comment")).toEqual({ event: "", data: "" });
        expect(parseSseEvent("event: ping")).toEqual({ event: "ping", data: "" });
        // A field name is exact: `data ` or `Data` is not `data`.
        expect(parseSseEvent("data :x\nData:y").data).toBe("");
    });
});
