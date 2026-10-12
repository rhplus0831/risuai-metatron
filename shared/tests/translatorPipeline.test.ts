// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TranslatorStep } from "../settings.ts";
import { defaultTranslatorPrompt } from "../translatorPresets.ts";
import type { TranslatorHistory, TranslatorHistorySlot } from "../translation/historySlots.ts";
import {
    buildTranslatorStepMessages,
    fillTranslatorSlots,
    isProtectedTranslationLine,
    parseTranslatorChatML,
    runTranslatorPipeline,
    stripTranslatorReasoning,
    translateProtectingLines,
    translatorHistorySlotCounts,
    translatorPipelineSignature,
    translatorStepsToRun,
    type TranslatorSlotValues,
} from "../translation/pipeline.ts";

// `docs/plan/translation.md` slice 1.2: the pure translator pipeline both runtimes share (the tab's
// `translateLLM` now, the server runner of slice 1.3). Step selection, the slots filled in one
// pass, the ChatML parse, the embedded-input rule, the reasoning stripped from every step's output,
// the signature the `LLMTranslateCache` key hashes, and the run itself.

const step = (overrides: Partial<TranslatorStep> = {}): TranslatorStep => ({
    id: "s",
    name: "Step",
    enabled: true,
    prompt: "",
    maxResponse: 1000,
    model: { mode: "inherit" },
    ...overrides,
});

const values = (overrides: Partial<TranslatorSlotValues> = {}): TranslatorSlotValues => ({
    sourceText: "SOURCE",
    prevOutput: "PREV",
    outputsByKey: new Map([["draft", "DRAFT"]]),
    to: "ko",
    from: "en",
    translatorNote: "NOTE",
    ...overrides,
});

describe("translatorStepsToRun", () => {
    it("runs the enabled steps in order, else the first step alone, and nothing of an empty list", () => {
        const a = step({ id: "a", enabled: false });
        const b = step({ id: "b" });
        const c = step({ id: "c" });
        expect(translatorStepsToRun([a, b, c])).toEqual([b, c]);
        expect(translatorStepsToRun([a, step({ id: "d", enabled: false })])).toEqual([a]);
        expect(translatorStepsToRun([])).toEqual([]);
    });
});

describe("parseTranslatorChatML", () => {
    it("is null unless the trimmed text starts with <|im_start|>", () => {
        expect(parseTranslatorChatML("Translate this.")).toBeNull();
        expect(parseTranslatorChatML("x <|im_start|>system y")).toBeNull();
        expect(parseTranslatorChatML("")).toBeNull();
    });

    it("splits the parts, reads the role before <|im_sep|>, a space, or a newline, and trims <|im_end|>", () => {
        expect(
            parseTranslatorChatML(
                "  <|im_start|>system<|im_sep|>You translate.<|im_end|>\n<|im_start|>user\nHello<|im_end|><|im_start|>assistant Hi<|im_end|>  ",
            ),
        ).toEqual([
            { role: "system", content: "You translate." },
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
        ]);
    });

    it("gives an unknown or missing role to the user and keeps an unterminated part", () => {
        expect(parseTranslatorChatML("<|im_start|>narrator<|im_sep|>x<|im_end|><|im_start|>tail")).toEqual([
            { role: "user", content: "narrator<|im_sep|>x" },
            { role: "user", content: "tail" },
        ]);
        // The role must be followed by a separator: `systematic` is content.
        expect(parseTranslatorChatML("<|im_start|>systematic text")).toEqual([
            { role: "user", content: "systematic text" },
        ]);
    });
});

describe("fillTranslatorSlots", () => {
    it("fills every slot, the misspelled content slot included, and leaves unknown braces alone", () => {
        const template =
            "to={{slot}} from={{slot::from}} c={{slot::content}} s={{solt::content}} p={{slot::prev}} o={{slot::out::draft}} n={{slot::tnote}} {{user}} {{slot::out::}}";
        expect(fillTranslatorSlots(template, values())).toBe(
            "to=ko from=en c=SOURCE s=SOURCE p=PREV o=DRAFT n=NOTE {{user}} {{slot::out::}}",
        );
    });

    it("fills in one pass: a filled value is never read for slots or `$` patterns again", () => {
        const filled = fillTranslatorSlots(
            "{{slot::content}} | {{slot::tnote}} | {{slot}}",
            values({ sourceText: "{{slot}} and {{slot::tnote}} $& $1 $$", translatorNote: "{{slot::content}}" }),
        );
        expect(filled).toBe("{{slot}} and {{slot::tnote}} $& $1 $$ | {{slot::content}} | ko");
    });

    it("reads a named output by its own key only: a missing one, prototype names included, is empty", () => {
        const outputsByKey = new Map([["__proto__", "P"]]);
        expect(
            fillTranslatorSlots(
                "[{{slot::out::missing}}][{{slot::out::constructor}}][{{slot::out::toString}}]",
                values(),
            ),
        ).toBe("[][][]");
        expect(fillTranslatorSlots("[{{slot::out::__proto__}}]", values({ outputsByKey }))).toBe("[P]");
        expect(fillTranslatorSlots("[{{slot::out::draft}}]", values({ outputsByKey: new Map() }))).toBe("[]");
    });
});

describe("buildTranslatorStepMessages", () => {
    it("sends a blank prompt as the default prompt plus the previous output as the user message", () => {
        expect(buildTranslatorStepMessages(step(), values())).toEqual([
            { role: "system", content: defaultTranslatorPrompt.replace("{{slot}}", "ko") },
            { role: "user", content: "PREV" },
        ]);
    });

    it("sends a ChatML prompt as its own messages and nothing else", () => {
        const prompt =
            "<|im_start|>system<|im_sep|>Translate into {{slot}}. Note: {{slot::tnote}}<|im_end|>\n<|im_start|>user<|im_sep|>{{slot::content}}<|im_end|>";
        expect(buildTranslatorStepMessages(step({ prompt }), values())).toEqual([
            { role: "system", content: "Translate into ko. Note: NOTE" },
            { role: "user", content: "SOURCE" },
        ]);
        // ChatML without any input slot still gets no appended user message.
        expect(
            buildTranslatorStepMessages(step({ prompt: "<|im_start|>system<|im_sep|>Only {{slot}}" }), values()),
        ).toEqual([{ role: "system", content: "Only ko" }]);
    });

    it("sends a prompt with an input slot as one system message, even when the slot fills in empty", () => {
        for (const prompt of [
            "Translate: {{slot::content}}",
            "Typo: {{solt::content}}",
            "Previous: {{slot::prev}}",
            "Named: {{slot::out::draft}}",
            "Unset: {{slot::out::nothing}}",
        ]) {
            const messages = buildTranslatorStepMessages(
                step({ prompt }),
                values({ sourceText: "", prevOutput: "", outputsByKey: new Map() }),
            );
            expect(messages, prompt).toHaveLength(1);
            expect(messages[0].role, prompt).toBe("system");
        }
        expect(buildTranslatorStepMessages(step({ prompt: "Translate: {{slot::content}}" }), values())).toEqual([
            { role: "system", content: "Translate: SOURCE" },
        ]);
    });

    it("judges the input slot on the template, not on the filled text", () => {
        // A source text that itself holds `{{slot::content}}` does not turn into an embedded input.
        expect(
            buildTranslatorStepMessages(step({ prompt: "Into {{slot}}" }), values({ prevOutput: "{{slot::content}}" })),
        ).toEqual([
            { role: "system", content: "Into ko" },
            { role: "user", content: "{{slot::content}}" },
        ]);
    });
});

describe("stripTranslatorReasoning", () => {
    it("returns text with no opening tag unchanged, surrounding whitespace and stray closing tags included", () => {
        expect(stripTranslatorReasoning("  plain  ")).toBe("  plain  ");
        expect(stripTranslatorReasoning("a </think> b")).toBe("a </think> b");
        expect(stripTranslatorReasoning("")).toBe("");
        // `<thinking>` is not a reasoning tag (word boundary).
        expect(stripTranslatorReasoning("<thinking>keep</thinking> x")).toBe("<thinking>keep</thinking> x");
    });

    it("removes the blocks, in any case and with attributes, and trims the rest", () => {
        expect(stripTranslatorReasoning("<Thoughts>hidden</Thoughts>\n\nVisible")).toBe("Visible");
        expect(stripTranslatorReasoning('A <THINK type="x">h</think> B <thoughts>\nh2\n</Thoughts > C')).toBe(
            "A  B  C",
        );
        expect(stripTranslatorReasoning("< think >h</ think >done")).toBe("done");
    });

    it("counts nested blocks, hides an unclosed block to the end, and keeps a closing tag outside a block", () => {
        expect(stripTranslatorReasoning("x<think>a<think>b</think>c</think>y")).toBe("xy");
        expect(stripTranslatorReasoning("before <think>never closed")).toBe("before");
        expect(stripTranslatorReasoning("<think>a</think>b</think>c")).toBe("b</think>c");
    });
});

describe("translatorPipelineSignature", () => {
    it("lists the steps that run by their request fields only", () => {
        const steps = [
            step({ id: "a", name: "First", prompt: "P1", maxResponse: 10, outputKey: "draft" }),
            step({ id: "b", name: "Off", enabled: false, prompt: "skipped" }),
            step({
                id: "c",
                name: "Third",
                prompt: "P3",
                maxResponse: 20,
                model: { mode: "profile", profileId: "pr" },
            }),
        ];
        expect(translatorPipelineSignature(steps)).toEqual([
            { prompt: "P1", maxResponse: 10, model: { mode: "inherit" }, outputKey: "draft" },
            { prompt: "P3", maxResponse: 20, model: { mode: "profile", profileId: "pr" }, outputKey: null },
        ]);
        // Neither the id nor the name is in it.
        const renamed = steps.map((entry) => ({ ...entry, id: `${entry.id}2`, name: `${entry.name}2` }));
        expect(JSON.stringify(translatorPipelineSignature(renamed))).toBe(
            JSON.stringify(translatorPipelineSignature(steps)),
        );
        // Turning a step on or off, or editing one, changes it.
        expect(translatorPipelineSignature(steps.map((entry) => ({ ...entry, enabled: true })))).toHaveLength(3);
        expect(translatorPipelineSignature([step({ prompt: "x" })])).not.toEqual(
            translatorPipelineSignature([step({ prompt: "y" })]),
        );
        // Nothing enabled: the first step alone.
        expect(translatorPipelineSignature(steps.map((entry) => ({ ...entry, enabled: false })))).toHaveLength(1);
    });
});

describe("runTranslatorPipeline", () => {
    const input = { sourceText: "SOURCE", to: "ko", from: "en", translatorNote: "NOTE" };

    it("chains the steps: each sees the stripped previous output and the earlier named outputs", async () => {
        const requests: { messages: unknown; maxResponse: number; model: unknown }[] = [];
        const outputs = ["<think>plan</think> DRAFT", "<Thoughts>x</Thoughts>\nFINAL\n"];
        const runStep = vi.fn(async (request: { messages: unknown; maxResponse: number; model: unknown }) => {
            requests.push(request);
            return outputs[requests.length - 1];
        });
        const steps = [
            step({ id: "a", prompt: "Draft {{slot::content}} into {{slot}}", maxResponse: 11, outputKey: "draft" }),
            step({ id: "off", enabled: false, prompt: "never" }),
            step({
                id: "b",
                prompt: "Polish {{slot::prev}} (draft {{slot::out::draft}}, source {{slot::content}}, {{slot::from}}, {{slot::tnote}})",
                maxResponse: 22,
                model: { mode: "profile", profileId: "pr" },
            }),
        ];
        await expect(runTranslatorPipeline({ steps, ...input }, runStep)).resolves.toBe("FINAL");
        expect(requests).toEqual([
            {
                messages: [{ role: "system", content: "Draft SOURCE into ko" }],
                maxResponse: 11,
                model: { mode: "inherit" },
            },
            {
                messages: [{ role: "system", content: "Polish DRAFT (draft DRAFT, source SOURCE, en, NOTE)" }],
                maxResponse: 22,
                model: { mode: "profile", profileId: "pr" },
            },
        ]);
    });

    it("gives the first step the source as its previous output, and an empty list returns the source", async () => {
        const runStep = vi.fn(async () => "OUT");
        await expect(runTranslatorPipeline({ steps: [step()], ...input }, runStep)).resolves.toBe("OUT");
        expect(runStep).toHaveBeenCalledWith({
            messages: [
                { role: "system", content: defaultTranslatorPrompt.replace("{{slot}}", "ko") },
                { role: "user", content: "SOURCE" },
            ],
            maxResponse: 1000,
            model: { mode: "inherit" },
        });
        await expect(runTranslatorPipeline({ steps: [], ...input }, runStep)).resolves.toBe("SOURCE");
        expect(runStep).toHaveBeenCalledTimes(1);
    });

    it("runs the first step alone when none is enabled, and ends the run on a step's error", async () => {
        const runStep = vi.fn(async () => "x");
        await runTranslatorPipeline(
            { steps: [step({ id: "a", enabled: false }), step({ id: "b", enabled: false })], ...input },
            runStep,
        );
        expect(runStep).toHaveBeenCalledTimes(1);

        const failing = vi.fn(async () => {
            throw new Error("provider down");
        });
        await expect(runTranslatorPipeline({ steps: [step(), step({ id: "t" })], ...input }, failing)).rejects.toThrow(
            "provider down",
        );
        expect(failing).toHaveBeenCalledTimes(1);
    });

    it("keeps a named output under its own key only (a prototype name is an ordinary key)", async () => {
        const seen: string[] = [];
        const runStep = vi.fn(async (request: { messages: { content: string }[] }) => {
            seen.push(request.messages[0].content);
            return `out${seen.length}`;
        });
        const steps = [
            step({ id: "a", prompt: "A {{slot::content}}", outputKey: "constructor" }),
            step({
                id: "b",
                prompt: "B [{{slot::out::constructor}}] [{{slot::out::toString}}] [{{slot::out::__proto__}}]",
            }),
        ];
        await expect(runTranslatorPipeline({ steps, ...input }, runStep)).resolves.toBe("out2");
        expect(seen).toEqual(["A SOURCE", "B [out1] [] []"]);
    });
});

// `docs/plan/translation.md` slice 3.2: the server runner's line protection when a preset does not
// send its text as is, the Fastify fork's `translatePreservingRawBlocks` exactly (the user's parity
// decision): each run of lines between protected lines is one trimmed chunk, a protected line is kept
// and followed by an empty chunk, and the parts are joined with `\n` and trimmed.
describe("isProtectedTranslationLine", () => {
    it("protects an exactly empty line and an asset line at column zero, case-sensitively; audio needs the closing braces at the end", () => {
        for (const line of ["", "{{img::a.png}}", "{{img", "{{raw::x}} tail", "{{video::v}}", "{{audio::a}}"]) {
            expect(isProtectedTranslationLine(line), JSON.stringify(line)).toBe(true);
        }
        for (const line of [
            " ",
            "\t",
            "\r",
            " {{img::a}}",
            "{{IMG::a}}",
            "{{image::a}}",
            "{{audio::a}} tail",
            "{{audio::a}",
            "{{inlay::a}}",
            "text {{img::a}}",
        ]) {
            expect(isProtectedTranslationLine(line), JSON.stringify(line)).toBe(false);
        }
    });
});

describe("translateProtectingLines", () => {
    const upper = vi.fn(async (chunk: string) => chunk.toUpperCase());
    const identity = async (chunk: string) => chunk;

    it("translates each run of lines between protected lines as one trimmed chunk, keeps the protected lines, trims each result and the whole", async () => {
        upper.mockClear();
        await expect(
            translateProtectingLines("  first line\nsecond  \n{{img::x}}\nthird\n{{audio::a}}\nfourth \n", upper),
        ).resolves.toBe("FIRST LINE\nSECOND\n{{img::x}}\nTHIRD\n{{audio::a}}\nFOURTH");
        expect(upper.mock.calls.map(([chunk]) => chunk)).toEqual(["first line\nsecond", "third", "fourth"]);
        // A chunk's result is trimmed, and so is the whole.
        await expect(translateProtectingLines("a\n\nb", async (chunk) => `  ${chunk}!\n`)).resolves.toBe("a!\n\nb!");
    });

    it("keeps an interior blank line and one protected line as they are, and gives two protected lines in a row an extra blank line", async () => {
        // The four examples of Astra's challenge (`docs/plan/translation.md` slice 3.2 As built).
        await expect(translateProtectingLines("a\n{{img::x}}\nb", identity)).resolves.toBe("a\n{{img::x}}\nb");
        await expect(translateProtectingLines("a\n\nb", identity)).resolves.toBe("a\n\nb");
        await expect(translateProtectingLines("{{img::a}}\n{{img::b}}", identity)).resolves.toBe(
            "{{img::a}}\n\n{{img::b}}",
        );
        await expect(translateProtectingLines("a\n\n\nb", identity)).resolves.toBe("a\n\n\n\nb");
        // A blank line before an asset line is two protected lines in a row too.
        await expect(translateProtectingLines("a\n\n{{img::x}}\nb", identity)).resolves.toBe("a\n\n\n{{img::x}}\nb");
    });

    it("makes no call for an empty, blank, or protected-only text and returns it trimmed", async () => {
        const never = vi.fn(async () => "NEVER");
        await expect(translateProtectingLines("", never)).resolves.toBe("");
        await expect(translateProtectingLines("\n\n", never)).resolves.toBe("");
        await expect(translateProtectingLines("   \n\t", never)).resolves.toBe("");
        await expect(translateProtectingLines("{{img::a}}", never)).resolves.toBe("{{img::a}}");
        await expect(translateProtectingLines("\n{{img::a}}\n{{raw::b}}\n", never)).resolves.toBe(
            "{{img::a}}\n\n{{raw::b}}",
        );
        expect(never).not.toHaveBeenCalled();
    });

    it("treats only an exactly empty line as a separator: a whitespace-only line and a CRLF blank line stay inside their chunk", async () => {
        upper.mockClear();
        await expect(translateProtectingLines("a\n \nb", upper)).resolves.toBe("A\n \nB");
        await expect(translateProtectingLines("a\r\n\r\nb", upper)).resolves.toBe("A\r\n\r\nB");
        // A CRLF `{{img` line is still protected (its start decides); a CRLF `{{audio …}}` line is
        // not (the `}}` must end the line). The chunk before a protected line loses its `\r` to the trim.
        await expect(translateProtectingLines("a\r\n{{img::x}}\r\nb", upper)).resolves.toBe("A\n{{img::x}}\r\nB");
        await expect(translateProtectingLines("a\r\n{{audio::x}}\r\nb", upper)).resolves.toBe("A\r\n{{AUDIO::X}}\r\nB");
        expect(upper.mock.calls.map(([chunk]) => chunk)).toEqual([
            "a\n \nb",
            "a\r\n\r\nb",
            "a",
            "b",
            "a\r\n{{audio::x}}\r\nb",
        ]);
    });

    it("runs the chunks one after another, and the first error ends the run before the later chunks are requested", async () => {
        const order: string[] = [];
        let inFlight = 0;
        const sequential = async (chunk: string) => {
            expect(inFlight).toBe(0);
            inFlight++;
            order.push(`start ${chunk}`);
            await new Promise((resolve) => setTimeout(resolve, 1));
            order.push(`end ${chunk}`);
            inFlight--;
            return chunk;
        };
        await expect(translateProtectingLines("a\n\nb\n\nc", sequential)).resolves.toBe("a\n\nb\n\nc");
        expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);

        const failing = vi.fn(async (chunk: string) => {
            if (chunk === "b") {
                throw new Error("provider down");
            }
            return chunk;
        });
        await expect(translateProtectingLines("a\n\nb\n\nc", failing)).rejects.toThrow("provider down");
        expect(failing.mock.calls.map(([chunk]) => chunk)).toEqual(["a", "b"]);
    });
});

// `docs/plan/translation.md` slice 3.3: the history slots in the pipeline. `{{slot::history::N}}` and
// `{{slot::historytrans::N}}` fill in from the caller's `history` in the same one pass as every other
// slot (empty without one, or for an invalid N); the counts a preset's executed prompts name are read
// from the same matches, so discovery and replacement agree on a nested malformed token; and a
// history slot is not an input slot.
describe("the history slots", () => {
    /** A history that records its calls and answers `<slot N>`. */
    function recording() {
        const calls: [TranslatorHistorySlot, number][] = [];
        const history: TranslatorHistory = (slot, count) => {
            calls.push([slot, count]);
            return `<${slot} ${count}>`;
        };
        return { calls, history };
    }

    it("fills a valid count from the history, leading zeros read as the number, and an invalid count as empty without asking", () => {
        const { calls, history } = recording();
        expect(
            fillTranslatorSlots(
                "[{{slot::history::1}}][{{slot::historytrans::50}}][{{slot::history::05}}][{{slot::historytrans::007}}]",
                values({ history }),
            ),
        ).toBe("[<history 1>][<historytrans 50>][<history 5>][<historytrans 7>]");
        expect(calls).toEqual([
            ["history", 1],
            ["historytrans", 50],
            ["history", 5],
            ["historytrans", 7],
        ]);
        calls.length = 0;
        const invalid =
            "[{{slot::history::0}}][{{slot::history::51}}][{{slot::historytrans::abc}}][{{slot::history::}}][{{slot::history:: 5}}][{{slot::historytrans::1.5}}][{{slot::history::-1}}]";
        expect(fillTranslatorSlots(invalid, values({ history }))).toBe("[][][][][][][]");
        expect(calls).toEqual([]);
        // Without the `::N` part it is not a slot: left as it is, like every unknown `{{...}}`.
        expect(
            fillTranslatorSlots("{{slot::history}} {{slot::historytrans}} {{slot::history::}}", values({ history })),
        ).toBe("{{slot::history}} {{slot::historytrans}} ");
        expect(calls).toEqual([]);
    });

    it("fills every history slot in empty without a history, keeping the other slots", () => {
        expect(
            fillTranslatorSlots("[{{slot::history::3}}][{{slot::historytrans::3}}][{{slot::content}}]", values()),
        ).toBe("[][][SOURCE]");
    });

    it("never reads a filled-in history, source, note, or output for slots", () => {
        const { history } = recording();
        const nested: TranslatorHistory = () => "{{slot::content}} {{slot::history::2}} $& $1";
        expect(fillTranslatorSlots("{{slot::history::1}}|{{slot::content}}", values({ history: nested }))).toBe(
            "{{slot::content}} {{slot::history::2}} $& $1|SOURCE",
        );
        expect(
            fillTranslatorSlots(
                "{{slot::content}}|{{slot::tnote}}|{{slot::out::draft}}|{{slot::prev}}",
                values({
                    history,
                    sourceText: "{{slot::history::1}}",
                    translatorNote: "{{slot::historytrans::1}}",
                    outputsByKey: new Map([["draft", "{{slot::history::2}}"]]),
                    prevOutput: "{{slot::history::3}}",
                }),
            ),
        ).toBe("{{slot::history::1}}|{{slot::historytrans::1}}|{{slot::history::2}}|{{slot::history::3}}");
    });

    it("consumes a nested malformed token the way the fill does: an input slot inside it is not an input slot, so the source still follows as the user message", () => {
        const { calls, history } = recording();
        // Astra's challenge finding 1: the invalid history token consumes `{{slot::content`.
        for (const inner of ["{{slot::content}}", "{{slot::prev}}", "{{solt::content}}", "{{slot::out::draft}}"]) {
            const prompt = `{{slot::history::${inner}}}`;
            expect(fillTranslatorSlots(prompt, values({ history })), prompt).toBe("}}");
            expect(buildTranslatorStepMessages(step({ prompt }), values({ history })), prompt).toEqual([
                { role: "system", content: "}}" },
                { role: "user", content: "PREV" },
            ]);
        }
        expect(calls).toEqual([]);
        // The other way round: an output slot swallows the history token, which is then not a count.
        const swallowed = "{{slot::out::{{slot::history::50}}}}";
        expect(fillTranslatorSlots(swallowed, values({ history }))).toBe("}}");
        expect(buildTranslatorStepMessages(step({ prompt: swallowed }), values({ history }))).toEqual([
            { role: "system", content: "}}" },
        ]);
        expect(translatorHistorySlotCounts([step({ prompt: swallowed })])).toEqual([]);
        expect(translatorHistorySlotCounts([step({ prompt: "{{slot::history::{{slot::content}}}}" })])).toEqual([]);
        expect(calls).toEqual([]);
    });

    it("is not an input slot: a prompt holding only history slots still sends the previous output as the user message", () => {
        const { history } = recording();
        expect(
            buildTranslatorStepMessages(
                step({ prompt: "Context:\n{{slot::history::2}}\n{{slot::historytrans::2}}\nInto {{slot}}" }),
                values({ history }),
            ),
        ).toEqual([
            { role: "system", content: "Context:\n<history 2>\n<historytrans 2>\nInto ko" },
            { role: "user", content: "PREV" },
        ]);
        // With an input slot beside it, the one system message as before.
        expect(
            buildTranslatorStepMessages(
                step({ prompt: "{{slot::history::2}}\n{{slot::content}}" }),
                values({ history }),
            ),
        ).toEqual([{ role: "system", content: "<history 2>\nSOURCE" }]);
        // ChatML with history slots: its own messages.
        expect(
            buildTranslatorStepMessages(
                step({
                    prompt: "<|im_start|>system<|im_sep|>{{slot::historytrans::1}}<|im_end|><|im_start|>user<|im_sep|>{{slot::content}}<|im_end|>",
                }),
                values({ history }),
            ),
        ).toEqual([
            { role: "system", content: "<historytrans 1>" },
            { role: "user", content: "SOURCE" },
        ]);
    });

    describe("translatorHistorySlotCounts", () => {
        it("lists each valid count of the executed steps' prompts once, in order of first appearance, from both slots", () => {
            const steps = [
                step({ id: "a", prompt: "{{slot::history::3}} {{slot::historytrans::3}} {{slot::history::05}}" }),
                step({ id: "off", enabled: false, prompt: "{{slot::history::9}}" }),
                step({ id: "b", prompt: "{{slot::historytrans::50}} {{slot::history::3}} {{slot::history::1}}" }),
            ];
            expect(translatorHistorySlotCounts(steps)).toEqual([3, 5, 50, 1]);
            // Nothing enabled: the first step alone (`translatorStepsToRun`).
            expect(translatorHistorySlotCounts(steps.map((entry) => ({ ...entry, enabled: false })))).toEqual([3, 5]);
            expect(translatorHistorySlotCounts([])).toEqual([]);
        });

        it("ignores invalid counts, a slot without a count, and the other slots; a blank prompt is the default prompt", () => {
            expect(
                translatorHistorySlotCounts([
                    step({
                        prompt: "{{slot::history::0}} {{slot::history::51}} {{slot::historytrans::abc}} {{slot::history::}} {{slot::history}} {{slot::history:: 2}} {{slot::content}} {{slot::out::history::2}}",
                    }),
                ]),
            ).toEqual([]);
            expect(translatorHistorySlotCounts([step({ prompt: "" })])).toEqual([]);
            expect(defaultTranslatorPrompt).not.toMatch(/slot::history/);
        });
    });

    it("runTranslatorPipeline hands the history to every step, and a step's output holding a slot is not read for it", async () => {
        const { calls, history } = recording();
        const seen: { role: string; content: string }[][] = [];
        const runStep = vi.fn(async (request: { messages: { role: string; content: string }[] }) => {
            seen.push(request.messages);
            return seen.length === 1 ? "{{slot::history::1}} out" : "final";
        });
        const steps = [
            step({ id: "a", prompt: "A {{slot::history::2}} {{slot::content}}", outputKey: "draft" }),
            step({ id: "b", prompt: "B {{slot::historytrans::2}} {{slot::prev}} [{{slot::out::draft}}]" }),
        ];
        const input = { sourceText: "SOURCE", to: "ko", from: "en", translatorNote: "" };
        await expect(runTranslatorPipeline({ steps, ...input, history }, runStep)).resolves.toBe("final");
        expect(seen).toEqual([
            [{ role: "system", content: "A <history 2> SOURCE" }],
            [{ role: "system", content: "B <historytrans 2> {{slot::history::1}} out [{{slot::history::1}} out]" }],
        ]);
        expect(calls).toEqual([
            ["history", 2],
            ["historytrans", 2],
        ]);
        // Without a history (the tab), the slots are empty and the input is kept.
        seen.length = 0;
        await runTranslatorPipeline({ steps, ...input }, runStep);
        expect(seen[0]).toEqual([{ role: "system", content: "A  SOURCE" }]);
    });
});
