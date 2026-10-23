// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import type { PromptItem } from "src/ts/process/prompt";
import { activeMainProfile, activePreset } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PromptSettings from "./PromptSettings.svelte";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
    if (component) await unmount(component);
    target?.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
});

it("recounts both displayed totals after changing the main model with the prompt template unchanged", async () => {
    vi.useFakeTimers();
    const template: PromptItem[] = [
        { type: "plain", type2: "normal", role: "system", text: "Describe the scene." },
        { type: "plain", type2: "normal", role: "system", text: "Continue the story." },
    ];
    installFlatDatabase({
        aiModel: "gpt-3.5-turbo",
        useTokenizerCaching: false,
        promptTemplate: structuredClone(template),
        characters: [],
    });
    activeMainProfile.modelId = "gpt-3.5-turbo";

    const requests: { scope: { aiModel: string }; texts: string[] }[] = [];
    mocks.authFetch.mockImplementation(async (path, init) => {
        expect(path).toBe("/api/tokens/count");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
        requests.push(body);
        return Response.json({ counts: body.texts.map(() => (body.scope.aiModel === "gpt-3.5-turbo" ? 11 : 29)) });
    });

    target = document.createElement("div");
    document.body.append(target);
    component = mount(PromptSettings, { target });
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    // Both totals include the two text items: 2 × the server's count for this model.
    expect(target.textContent).toContain("22 Approximate Tokens");
    expect(target.textContent).toContain("22 Exact Tokens");
    expect(requests.flatMap((request) => request.texts)).toEqual(
        expect.arrayContaining(["Describe the scene.", "Continue the story."]),
    );
    const initialRequests = requests.length;

    activeMainProfile.modelId = "gpt4om";
    flushSync();
    await vi.advanceTimersByTimeAsync(399);
    expect(requests).toHaveLength(initialRequests);
    expect(target.textContent).toContain("22 Approximate Tokens");
    expect(target.textContent).toContain("22 Exact Tokens");
    await vi.advanceTimersByTimeAsync(1);
    // Drain the tokenizer's queued zero-delay request batch.
    await vi.runOnlyPendingTimersAsync();
    flushSync();
    expect(target.textContent).toContain("58 Approximate Tokens");
    expect(target.textContent).toContain("58 Exact Tokens");
    const recounted = requests.slice(initialRequests);
    expect(recounted).not.toHaveLength(0);
    expect(recounted.every((request) => request.scope.aiModel === "gpt4om")).toBe(true);
    expect(recounted.flatMap((request) => request.texts)).toEqual(
        expect.arrayContaining(["Describe the scene.", "Continue the story."]),
    );
    expect(activePreset.promptTemplate).toEqual(template);
});
