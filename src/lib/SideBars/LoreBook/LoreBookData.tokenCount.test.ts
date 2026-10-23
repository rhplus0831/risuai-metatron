// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { reactiveProps } from "src/lib/UI/tests/reactiveProps.svelte";
import { setChatVar } from "src/ts/parser/chatVar.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { activeMainProfile } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import LoreBookData from "./LoreBookData.svelte";

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

it("recounts an open entry after main-model and referenced chat-variable changes without editing its text", async () => {
    vi.useFakeTimers();
    installFlatDatabaseWithChats({
        aiModel: "gpt-3.5-turbo",
        useTokenizerCaching: false,
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                globalLore: [
                    {
                        key: "lore",
                        comment: "Lore",
                        content: "The location is {{getvar::x}}.",
                        mode: "normal",
                        insertorder: 100,
                        alwaysActive: false,
                        secondkey: "",
                        selective: false,
                    },
                ],
                chats: [{ id: "k", name: "K", note: "", localLore: [], message: [], scriptstate: { $x: "home" } }],
            },
        ],
    });
    selectCharacter("c");
    selectChat("c", "k");
    activeMainProfile.modelId = "gpt-3.5-turbo";

    const requests: { scope: { aiModel: string }; texts: string[] }[] = [];
    mocks.authFetch.mockImplementation(async (path, init) => {
        expect(path).toBe("/api/tokens/count");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
        requests.push(body);
        return Response.json({ counts: body.texts.map(() => (body.scope.aiModel === "gpt-3.5-turbo" ? 11 : 29)) });
    });

    const value = characterList()[0].globalLore[0];
    target = document.createElement("div");
    document.body.append(target);
    component = mount(LoreBookData, {
        target,
        props: reactiveProps({ value, idx: 0, idgroup: "test", isOpen: true, externalLoreBooks: [value] }),
    });
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(target.textContent).toContain("11 Tokens");
    expect(requests).toEqual([
        expect.objectContaining({
            scope: expect.objectContaining({ aiModel: "gpt-3.5-turbo" }),
            texts: ["The location is home."],
        }),
    ]);

    activeMainProfile.modelId = "gpt4om";
    flushSync();
    await vi.advanceTimersByTimeAsync(399);
    expect(requests).toHaveLength(1);
    expect(target.textContent).toContain("11 Tokens");
    await vi.advanceTimersByTimeAsync(1);
    flushSync();
    expect(target.textContent).toContain("29 Tokens");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ scope: { aiModel: "gpt4om" }, texts: ["The location is home."] });

    expect(setChatVar("x", "the observatory")).toBe(true);
    flushSync();
    await vi.advanceTimersByTimeAsync(399);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    flushSync();
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ scope: { aiModel: "gpt4om" }, texts: ["The location is the observatory."] });
    expect(target.textContent).toContain("29 Tokens");
    expect(value.content).toBe("The location is {{getvar::x}}.");
});
