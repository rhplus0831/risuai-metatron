// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createWriterEffect } from "../storage/tests/reactiveProbe.svelte";
import { memoryTextSearch } from "./structuredMemory.svelte";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>() }));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch }),
);
afterEach(() => {
    authFetch.mockReset();
});

const ref = { chaId: "c", chatId: "k" };
const hit = { kind: "page", id: "gate", title: "Gate", heading: "Watch", excerpt: "Light at the gate" };
const matches = () => Response.json({ revision: "r", hits: [hit], next: null });

function ownSearch(getters: Parameters<typeof memoryTextSearch>[0]) {
    let search: ReturnType<typeof memoryTextSearch>;
    const owner = createWriterEffect(() => {
        search = memoryTextSearch(getters);
    });
    onTestFinished(owner.dispose);
    return search!;
}

it.each([
    { field: "draft", change: { draft: "harbor" } },
    { field: "character ID", change: { chat: { ...ref, chaId: "other" } } },
    { field: "chat ID", change: { chat: { ...ref, chatId: "other" } } },
    { field: "refresh", change: { refresh: 1 } },
])("drops a pending answer when the $field changes", async ({ change }) => {
    // Change what the getters return before an effect can clear the search or start another request.
    const inputs = { chat: ref, refresh: 0, draft: "gate" };
    const search = ownSearch({ chat: () => inputs.chat, refresh: () => inputs.refresh, draft: () => inputs.draft });
    authFetch.mockResolvedValueOnce(matches());
    const pending = search.search(inputs.draft);
    Object.assign(inputs, change);
    await pending;
    expect(search.result).toBeNull();
    expect(search.failure).toBeNull();
});

it("reruns the submitted query on refresh and exposes the new read's failure", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const refresh = fromStore(writable(0));
    const search = ownSearch({ chat: () => ref, refresh: () => refresh.current, draft: () => "gate" });
    authFetch
        .mockResolvedValueOnce(matches())
        .mockResolvedValueOnce(Response.json({ error: "Offline" }, { status: 503 }));
    await search.search("gate");
    expect(search.result).toEqual({ hits: [hit], more: false });

    refresh.current += 1;
    flushSync();
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
        "/api/memory/structured/c/k/find?q=gate",
        "/api/memory/structured/c/k/find?q=gate",
    ]);
    expect(search).toMatchObject({ searched: "gate", showing: true, searching: true });
    await vi.runAllTimersAsync();
    expect(search).toMatchObject({ searching: false, result: null, failure: { outcome: "failed", error: "Offline" } });
});

it("clears the search on draft and chat changes and ignores a superseded submission of the same text", async () => {
    const draft = fromStore(writable("gate"));
    const chat = fromStore(writable(ref));
    const search = ownSearch({ chat: () => chat.current, refresh: () => 0, draft: () => draft.current });
    let finishFirst!: (response: Response) => void;
    authFetch
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishFirst = resolve;
                }),
        )
        .mockResolvedValueOnce(matches());
    const first = search.search("gate");
    const cleared = { searched: null, searching: false, showing: false, result: null, failure: null };
    draft.current = "harbor";
    flushSync();
    expect(search).toMatchObject(cleared);
    draft.current = "gate";
    flushSync();
    expect(search.showing).toBe(false);
    await search.search("gate");
    finishFirst(Response.json({ error: "Superseded" }, { status: 503 }));
    await first;
    expect(search).toMatchObject({
        searched: "gate",
        showing: true,
        searching: false,
        result: { hits: [hit], more: false },
        failure: null,
    });
    chat.current = { ...ref, chatId: "other" };
    flushSync();
    expect(search).toMatchObject(cleared);
});
