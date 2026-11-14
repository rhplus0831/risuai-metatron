import { describe, expect, it } from "vitest";
import { MAX_OOC_EXCHANGES, oocPrune, oocTail, oocToggleValues, type OocExchange, type OocLog } from "./ooc.ts";

const exchange = (id: string, segment: string, time: number, extra: Partial<OocExchange> = {}): OocExchange => ({
    id,
    segment,
    anchorMessageId: null,
    question: `Question ${id}`,
    time,
    ...extra,
});

describe("oocTail", () => {
    it("orders segment exchanges through the question, places answered attachments once, and skips deleted attachments and earlier unanswered exchanges", () => {
        const log: OocLog = {
            later: exchange("later", "current", 30, { answer: "Later answer" }),
            target: exchange("target", "current", 20, { attached: ["b", "deleted", "a", "unanswered"] }),
            pending: exchange("pending", "current", 15),
            first: exchange("first", "current", 10, { answer: "First answer", attached: ["b"] }),
            a: exchange("a", "previous", 1, { answer: "Answer A" }),
            b: exchange("b", "previous", 2, { answer: "Answer B" }),
            unanswered: exchange("unanswered", "previous", 3),
        };

        const rows = oocTail(log, "target");
        expect(rows).toEqual([
            { id: expect.any(String), role: "user", data: "Question b" },
            { id: expect.any(String), role: "char", data: "Answer B" },
            { id: expect.any(String), role: "user", data: "Question first" },
            { id: expect.any(String), role: "char", data: "First answer" },
            { id: expect.any(String), role: "user", data: "Question a" },
            { id: expect.any(String), role: "char", data: "Answer A" },
            { id: expect.any(String), role: "user", data: "Question target" },
        ]);
        expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    });
});

describe("oocToggleValues", () => {
    it("uses the preset alone, replaces it with a chat map, and forces nothing for an empty chat map", () => {
        const preset = { mode: "story", detail: "1", invalid: 2 };
        expect(oocToggleValues(undefined, preset)).toEqual({ toggle_mode: "story", toggle_detail: "1" });
        expect(oocToggleValues({ mode: "ooc", invalid: false }, preset)).toEqual({ toggle_mode: "ooc" });
        expect(oocToggleValues({}, preset)).toEqual({});
    });
});

const fullLog = (): OocLog =>
    Object.fromEntries(
        Array.from({ length: MAX_OOC_EXCHANGES }, (_, time) => {
            const id = `e-${time}`;
            return [id, exchange(id, "previous", time)];
        }).reverse(),
    );
const currentSegment = { id: "current", anchorMessageId: null };

describe("oocPrune", () => {
    it("removes only enough exchanges for one more, oldest first, and removes none when there is room", () => {
        const log = fullLog();
        log.extra = exchange("extra", "previous", MAX_OOC_EXCHANGES);
        expect(oocPrune(log, currentSegment, [])).toEqual(["e-0", "e-1"]);
        delete log.extra;
        delete log["e-0"];
        expect(oocPrune(log, currentSegment, [])).toEqual([]);
    });

    it("keeps the current segment, its attachments, and picked exchanges", () => {
        const log = fullLog();
        log["e-0"] = exchange("e-0", "current", 0, { attached: ["e-1"] });
        expect(oocPrune(log, currentSegment, ["e-2"])).toEqual(["e-3"]);
    });

    it("returns null when no exchange can be removed", () => {
        const log = fullLog();
        for (const entry of Object.values(log)) entry.segment = "current";
        expect(oocPrune(log, currentSegment, [])).toBeNull();
    });
});
