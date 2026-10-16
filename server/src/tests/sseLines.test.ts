// @vitest-environment node
import { expect, it } from "vitest";
import { SseLines } from "../llm/sseLines.ts";

it("returns only newly completed lines and flushes the unfinished suffix once", () => {
    const lines = new SseLines();
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(lines.push(encode("data:A\r"))).toEqual([]);
    expect(lines.push(encode("\n\n: comment\ndata:B"))).toEqual(["data:A", "", ": comment"]);
    // The pending prefix and decoder must both survive arbitrarily small reads.
    const character = encode("🙂");
    for (const byte of character) expect(lines.push(Uint8Array.of(byte))).toEqual([]);
    expect(lines.push(encode("\nfinal\r"))).toEqual(["data:B🙂"]);
    expect(lines.end()).toEqual(["final"]);
    expect(lines.end()).toEqual([]);

    const terminated = new SseLines();
    expect(terminated.push(encode("one\n"))).toEqual(["one"]);
    expect(terminated.end()).toEqual([]);
});
