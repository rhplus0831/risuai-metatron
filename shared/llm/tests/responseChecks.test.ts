import { describe, expect, it } from "vitest";
import { risuEscape } from "../../cbs/evaluator.ts";
import {
    measureResponseLength,
    normalizeMinResponseLength,
    responseRejection,
    type ResponseCheckSettings,
} from "../responseChecks.ts";

describe("measureResponseLength", () => {
    it("keeps text between thought blocks, removes nested thoughts, and counts unmatched tags literally", () => {
        const thoughts = "<Thoughts>outer<Thoughts>inner</Thoughts>tail</Thoughts>";
        expect(measureResponseLength(thoughts + "reply<Thoughts>later</Thoughts>")).toBe(5);
        expect(measureResponseLength("</Thoughts>reply<Thoughts>")).toBe(26);
    });

    it("counts trimmed Unicode code points around tool records and both spellings of all inlay markers", () => {
        const markers = "{{inlay::image}}{{inlayed::signature}}{{inlayeddata::data}}";
        const answer = "\t<tool_call>lookup\nrecord</tool_call>" + markers + "🙂\uE9BC" + risuEscape(markers) + " \n";
        // The emoji and the private-use character outside the markers each count once.
        expect(measureResponseLength(answer)).toBe(2);
        expect(measureResponseLength(risuEscape("{{inlay::image}}"))).toBe(0);
    });
});

it("turns invalid minimums off and truncates and caps finite minimums", () => {
    for (const [input, expected] of [
        [undefined, 0],
        [0.9, 0],
        ["5", 0],
        [Infinity, 0],
        [NaN, 0],
        [2.5, 2],
        [100_001, 100_000],
    ] as const) {
        expect(normalizeMinResponseLength(input), String(input)).toBe(expected);
    }
});

describe("responseRejection", () => {
    const settings: ResponseCheckSettings = {
        banCharacterset: ["Han"],
        minResponseLengthModel: 2.5,
        minResponseLengthSubmodel: 3,
        minResponseLengthMemory: 4,
        minResponseLengthEmotion: 5,
        minResponseLengthOtherAx: 6,
        minResponseLengthTranslate: 7,
    };

    it("reports the banned script before the minimum when both checks reject the answer", () => {
        expect(responseRejection("<Thoughts>漢</Thoughts>", settings, { mode: "model" })).toBe(
            "The model answered in a banned script (Han)",
        );
    });

    it("accepts short continuations and still rejects a continuation in a banned script", () => {
        const continuation = { mode: "model", continue: true } as const;
        expect(responseRejection("!", settings, continuation)).toBeNull();
        expect(responseRejection("漢", settings, continuation)).toBe("The model answered in a banned script (Han)");
    });

    it("enforces the normalized minimum of each request kind", () => {
        for (const [mode, minimum] of [
            ["model", 2],
            ["submodel", 3],
            ["memory", 4],
            ["emotion", 5],
            ["otherAx", 6],
            ["translate", 7],
        ] as const) {
            expect(responseRejection(" 🙂 ", settings, { mode }), mode).toBe(
                `The model's answer was shorter than the minimum (1 < ${minimum})`,
            );
            expect(responseRejection("a".repeat(minimum), settings, { mode }), mode).toBeNull();
        }
    });
});
