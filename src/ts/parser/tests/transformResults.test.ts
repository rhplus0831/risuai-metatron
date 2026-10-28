import { beforeEach, describe, expect, it } from "vitest";
import { clearTransformResults, getTransformResult, replaceTransformResult } from "../transformResults";

beforeEach(clearTransformResults);

describe("confirmed transform result bounds", () => {
    it("retains empty results and evicts the least recently used entry at the entry bound", () => {
        // The tab admits at most 2,048 entries, even when every result is empty.
        for (let i = 0; i < 2_048; i++) {
            replaceTransformResult(`target-${i}`, undefined, "message", { key: `key-${i}`, source: "", text: "" });
        }
        expect(getTransformResult("target-0", "")).toMatchObject({ text: "", key: "key-0" });
        replaceTransformResult("newest", undefined, "message", { key: "new", source: "", text: "" });
        expect(getTransformResult("target-1", "")).toBeUndefined();
        expect(getTransformResult("target-0", "")).toMatchObject({ text: "" });
        expect(getTransformResult("newest", "")).toMatchObject({ text: "" });
    });

    it("bounds repeated source edits by bytes including retained sources and identities", () => {
        // Each edit retains over half a MiB of UTF-16 strings, despite producing empty text.
        // Sixteen such edits exceed the tab's 8 MiB allowance; this is well below its entry cap.
        const edits = Array.from({ length: 16 }, (_, i) => ({
            identity: `${i.toString().padStart(2, "0")}:${"context".repeat(10_000)}`,
            source: `${i.toString().padStart(2, "0")}:${"source".repeat(33_000)}`,
        }));
        for (const { identity, source } of edits) {
            replaceTransformResult(identity, undefined, "same-message", { key: "key", source, text: "" });
        }
        expect(getTransformResult(edits[0].identity, edits[0].source)).toBeUndefined();
        for (const { identity, source } of edits.slice(1)) {
            expect(getTransformResult(identity, source)).toMatchObject({ source, text: "" });
        }
    });
});
