import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PromptItem } from "../../../shared/prompt";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import { tokenizePreset } from "./prompt";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);

beforeEach(() => {
    vi.useFakeTimers();
    mocks.authFetch.mockReset();
    installFlatDatabase({ aiModel: "gpt4om", useTokenizerCaching: false });
});
afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
});

it("parses eligible template items in order and sums their counts from one request", async () => {
    const counts: Record<string, number> = {
        MAIN: 2,
        jailbreak: 3,
        PERSONA: 5,
        DESCRIPTION: 7,
        LOREBOOK: 11,
        POST: 13,
        NOTE: 17,
        MEMORY: 19,
    };
    mocks.authFetch.mockImplementation(async (_path, init) => {
        const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
        return Response.json({ counts: texts.map((text) => counts[text] ?? 0) });
    });
    const prompts: PromptItem[] = [
        { type: "plain", type2: "main", role: "system", text: "{{upper::main}}" },
        { type: "chat", rangeStart: 0, rangeEnd: "end" },
        { type: "jailbreak", type2: "normal", role: "system", text: "{{lower::JAILBREAK}}" },
        { type: "persona", innerFormat: "{{upper::persona}}{{slot}}" },
        { type: "description", innerFormat: "{{upper::description}}" },
        { type: "lorebook", innerFormat: "{{upper::lorebook}}" },
        { type: "postEverything", innerFormat: "{{upper::post}}" },
        { type: "authornote", innerFormat: "{{upper::note}}" },
        { type: "memory", innerFormat: "{{upper::memory}}" },
        { type: "description" },
        { type: "persona", innerFormat: "" },
        { type: "chatML", text: "not counted" },
        { type: "cot", type2: "normal", role: "system", text: "not counted either" },
    ];
    const total = tokenizePreset(prompts, true);
    await vi.runAllTimersAsync();

    expect(await total).toBe(2 + 3 + 5 + 7 + 11 + 13 + 17 + 19);
    expect(mocks.authFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mocks.authFetch.mock.calls[0];
    expect(path).toBe("/api/tokens/count");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
        scope: { aiModel: "gpt4om", useTokenizerCaching: false },
        texts: ["MAIN", "jailbreak", "PERSONA", "DESCRIPTION", "LOREBOOK", "POST", "NOTE", "MEMORY"],
    });
});
