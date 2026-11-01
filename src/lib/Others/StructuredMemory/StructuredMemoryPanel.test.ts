// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { fromStore, get, writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContextReport } from "../../../../shared/contextReport.ts";
import { previewChat, previewChatReport } from "src/ts/process/index.svelte";
import type { Message } from "../../../../shared/database.ts";
import { language } from "src/lang";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    findChat,
    hydrateChat,
    seedChats,
    selectChat,
    setMessageText,
    patchMessage,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { hypaV3ModalOpen, loadedStore } from "src/ts/stores.svelte";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { followedJobs } from "src/ts/process/serverCommands";
import { noteMemoryTaskFrame, resetMemoryTasks } from "src/ts/process/memoryTasks.svelte";
import StructuredMemoryPanel from "./StructuredMemoryPanel.svelte";
import PreviewTab from "./PreviewTab.svelte";

const io = vi.hoisted(() => ({
    runServerJob: vi.fn<typeof import("src/ts/process/serverCommands").runServerJob>(),
    authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>(),
    downloadFile: vi.fn<typeof import("src/ts/globalApi.svelte").downloadFile>(),
}));
vi.mock("src/ts/process/serverCommands", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/process/serverCommands")>()),
    runServerJob: io.runServerJob,
}));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: io.authFetch }),
);
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({ downloadFile: io.downloadFile }),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

const ref = { chaId: "c", chatId: "k" };
const epoch = "0f3d4b9a-0000-4000-8000-000000000001";
const revision = (n: number) => `${epoch}:1:${n}`;
const message = (id: string, role: "user" | "char", data = id): Message => ({ chatId: id, role, data });
const facts = (id = "event", messageIds = ["u0"]) => ({
    revision: "r1",
    events: [{ id, title: id, status: "active", messageIds }],
    runs: [],
    next: null,
});
const logRound = (id = "run", next: number | null = null, revision = "r1") => ({
    revision,
    runs: [{ id, result: "pending", window: [], model: id }],
    total: 2,
    next,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
// Drain the known promise-only transport and Svelte effects. No clock or polling deadline.
async function settle() {
    for (let i = 0; i < 80; i++) {
        await Promise.resolve();
        flushSync();
    }
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 80; i++) {
        await Promise.resolve();
        flushSync();
    }
}
let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | undefined;
const releases: (() => void)[] = [];
const query = (selector: string) => target.querySelector<HTMLElement>(selector);
const click = (selector: string) => {
    expect(query(selector)).not.toBeNull();
    query(selector)!.click();
    flushSync();
};
const reads = (route = "coverage") => io.authFetch.mock.calls.filter(([url]) => url.includes(`/${route}`));
async function open() {
    instance = mount(StructuredMemoryPanel, { target });
    flushSync();
    await settle();
}
function install(
    messages = [message("u0", "user"), message("a0", "char"), message("u1", "user"), message("a1", "char")],
) {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "",
                supaMemory: true,
                chats: [
                    { id: "k", name: "K", note: "", localLore: [], message: messages },
                    { id: "other", name: "Other", note: "", localLore: [], message: [message("other", "char")] },
                ],
            },
        ],
        memoryAlgorithmType: "structuredMemory",
        aiModel: "gpt4om",
        useTokenizerCaching: false,
        hypaV3Presets: [{ id: "memory", name: "Memory", settings: { structured: { windowTurns: 1 } } }],
        hypaV3PresetId: "memory",
    });
    selectCharacter("c");
    selectChat("c", "k");
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    io.authFetch.mockReset().mockImplementation(async (url, init) => {
        if (url === "/api/tokens/count")
            return Response.json({ counts: JSON.parse(init!.body as string).texts.map(() => 1) });
        if (url.includes("/coverage")) return Response.json(facts());
        if (url.includes("/runs")) return Response.json(logRound());
        throw new Error(`Unexpected request: ${url}`);
    });
    io.runServerJob.mockReset();
    io.downloadFile.mockReset().mockResolvedValue(undefined);
    resetMemoryTasks();
    followedJobs.set(new Map());
    install();
    hypaV3ModalOpen.set(true);
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    for (const release of releases.splice(0)) release();
    await settle();
    resetMemoryTasks();
    followedJobs.set(new Map());
    hypaV3ModalOpen.set(false);
    target.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});

it("switches Coverage and Log with SegmentedControl and refreshes after each chat fence falls", async () => {
    seedChats(
        [{ characterId: "c", id: "k", revision: revision(1) }],
        [{ characterId: "c", revision: revision(1), ids: ["k", "other"] }],
    );
    await open();
    expect(query('[data-memory-panel="coverage"]')).not.toBeNull();
    expect(target.querySelectorAll("[data-segment-btn]")).toHaveLength(3);
    expect(query('[data-segment-btn][aria-pressed="true"]')?.textContent).toBe(
        language.structuredMemory.panel.coverage,
    );
    const assertFence = (held: boolean) => {
        expect(!!query("[data-memory-panel-read-only]")).toBe(held);
        expect(query("[data-memory-coverage]")?.dataset.readOnly).toBe(String(held));
    };
    assertFence(false);
    const foreign = beginLocalSend({ ...ref, chatId: "other" })!;
    releases.push(foreign);
    flushSync();
    assertFence(false);
    foreign();
    const release = beginLocalSend(ref)!;
    releases.push(release);
    flushSync();
    assertFence(true);
    let count = reads().length;
    release();
    await settle();
    assertFence(false);
    expect(reads()).toHaveLength(count + 1);
    followedJobs.set(new Map([["job", chatStatusKey(ref)]]));
    flushSync();
    assertFence(true);
    count = reads().length;
    followedJobs.set(new Map());
    await settle();
    assertFence(false);
    expect(reads()).toHaveLength(count + 1);
    noteMemoryTaskFrame({
        characterId: "c",
        chatId: "k",
        status: { taskId: "task", state: "running", done: 0, total: 1 },
    });
    flushSync();
    assertFence(true);
    count = reads().length;
    noteMemoryTaskFrame({
        characterId: "c",
        chatId: "k",
        status: {
            taskId: "task",
            state: "done",
            done: 1,
            total: 1,
            terminalRevision: revision(2),
            lastCommittedRevision: revision(2),
        },
    });
    await settle();
    assertFence(true);
    expect(reads()).toHaveLength(count);
    hydrateChat({ characterId: "c", id: "k", revision: revision(2), data: JSON.parse(JSON.stringify(findChat(ref))) });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    assertFence(false);
    expect(reads()).toHaveLength(count + 1);
    count = reads().length;
    click("[data-memory-panel-refresh]");
    await settle();
    expect(reads()).toHaveLength(count + 1);
    click("[data-segment-btn]:last-child");
    await settle();
    expect(query('[data-memory-panel="log"]')).not.toBeNull();
    expect(query("[data-memory-log]")?.dataset.readOnly).toBe("false");
    count = reads("runs").length;
    click("[data-memory-panel-refresh]");
    await settle();
    expect(reads("runs")).toHaveLength(count + 1);
    click("[data-memory-panel-close]");
    expect(get(hypaV3ModalOpen)).toBe(false);
});

it("shows rows before token counts and ignores counts from an older coverage join", async () => {
    const tokenAnswers: { texts: string[]; answer: ReturnType<typeof deferred<Response>> }[] = [];
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) => {
        if (url !== "/api/tokens/count") return fetch(url, init, options);
        const answer = deferred<Response>();
        tokenAnswers.push({ texts: JSON.parse(init!.body as string).texts, answer });
        return answer.promise;
    });
    await open();
    expect(query('[data-memory-coverage-row="covered"]')).not.toBeNull();
    expect(tokenAnswers.flatMap(({ texts }) => texts).sort()).toEqual(["a0", "u0"]);
    expect(query("[data-memory-coverage-gap]")?.textContent).toContain(
        language.structuredMemory.coverage.countingTokens,
    );
    const old = tokenAnswers.splice(0);
    setMessageText(ref, "u0", "new covered text");
    await settle();
    expect(tokenAnswers.flatMap(({ texts }) => texts).sort()).toEqual(["a0", "new covered text"]);
    for (const { texts, answer } of tokenAnswers)
        answer.resolve(Response.json({ counts: texts.map((text) => (text === "a0" ? 7 : 19)) }));
    await settle();
    expect(query("[data-memory-coverage-gap]")?.textContent).toContain(
        language.structuredMemory.coverage.aboutTokens(7),
    );
    expect(query("[data-memory-coverage-leaving]")?.textContent).toContain(
        language.structuredMemory.coverage.aboutTokens(19),
    );
    for (const { texts, answer } of old) answer.resolve(Response.json({ counts: texts.map(() => 999) }));
    await settle();
    expect(query("[data-memory-coverage-leaving]")?.textContent).toContain(
        language.structuredMemory.coverage.aboutTokens(19),
    );
    characterList().find(({ chaId }) => chaId === "c")!.supaMemory = false;
    await settle();
    for (const { texts, answer } of tokenAnswers) answer.resolve(Response.json({ counts: texts.map(() => 7) }));
    await settle();
    expect(query("[data-memory-coverage-off]")).not.toBeNull();
    expect(query("[data-memory-coverage-leaving]")?.textContent).toContain(
        language.structuredMemory.coverage.aboutTokens(0),
    );
});

it.each(["coverage", "log"])(
    "ignores older %s reads and another chat's answers, and replaces rows with failures",
    async (tab) => {
        const pending: ReturnType<typeof deferred<Response>>[] = [];
        const fetch = io.authFetch.getMockImplementation()!;
        const route = tab === "coverage" ? "coverage" : "runs";
        io.authFetch.mockImplementation((url, init, options) => {
            if (!url.includes(`/${route}`)) return fetch(url, init, options);
            const answer = deferred<Response>();
            pending.push(answer);
            return answer.promise;
        });
        await open();
        if (tab === "log") {
            click("[data-segment-btn]:last-child");
            await settle();
        }
        click("[data-memory-panel-refresh]");
        await settle();
        const body = (id: string) => (tab === "coverage" ? facts(id, ["u0"]) : logRound(id));
        pending[1].resolve(Response.json(body("newest-answer")));
        await settle();
        expect(target.textContent).toContain("newest-answer");
        pending[0].resolve(Response.json(body("obsolete-answer")));
        await settle();
        expect(target.textContent).not.toContain("obsolete-answer");
        expect(target.textContent).toContain("newest-answer");
        click("[data-memory-panel-refresh]");
        await settle();
        selectChat("c", "other");
        await settle();
        pending[3].resolve(Response.json(tab === "coverage" ? facts("other-chat", ["other"]) : logRound("other-chat")));
        await settle();
        pending[2].resolve(Response.json(body("foreign-answer")));
        await settle();
        expect(target.textContent).toContain("other-chat");
        expect(target.textContent).not.toContain("foreign-answer");
        click("[data-memory-panel-refresh]");
        await settle();
        pending[4].resolve(Response.json({ reason: "chatGone" }, { status: 404 }));
        await settle();
        expect(query("[data-memory-panel-failure]")).not.toBeNull();
        expect(target.querySelectorAll("[data-memory-coverage-row], [data-memory-run]")).toHaveLength(0);
    },
);

it("pages a long coverage group and renders message text literally", async () => {
    const literal = '<img src=x onerror="alert(1)"> **message**';
    install(
        Array.from({ length: 405 }, (_, index) =>
            message(`m${index}`, "user", index === 0 ? literal : `Message ${index}`),
        ),
    );
    await open();
    click("[data-memory-coverage-group]");
    expect(target.querySelectorAll("[data-memory-coverage-row]")).toHaveLength(200);
    expect(target.textContent).toContain(literal);
    expect(target.querySelector("img, strong")).toBeNull();
    const more = [...target.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === language.structuredMemory.panel.showMore(205),
    )!;
    expect(more).toBeDefined();
    more.click();
    flushSync();
    expect(target.querySelectorAll("[data-memory-coverage-row]")).toHaveLength(400);
    expect(target.textContent).toContain("Message 399");
    expect(target.textContent).not.toContain("Message 400");
});

it("shows run metrics and extracted items beside their verified or unverified quotes as plain text, and exports JSON", async () => {
    const literal = '<img src=x onerror="alert(1)">';
    const run = {
        id: "extracted",
        result: "failed",
        model: literal,
        window: [{ index: 2 }, { index: 5 }],
        inputTokens: 23,
        outputTokens: 17,
        durationMs: 1250,
        error: "provider failure",
        analysis: {
            event: {
                title: "Extracted title",
                summary: "**summary**",
                keyLines: [{ speaker: "Speaker", text: "verbatim" }],
                stateChanges: [
                    { pageId: "door", section: "state", before: "closed", after: "open", quote: "door quote" },
                ],
                knowledge: [{ pageId: "secret", fact: "the fact", stance: "believes", quote: literal, knowers: [] }],
            },
        },
        receipt: { state: "failed", unverified: [{ kind: "knowledge", text: literal, reason: "quoteNotFound" }] },
    };
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url.includes("/runs")
            ? Promise.resolve(Response.json({ revision: "export-revision", total: 1, runs: [run], next: null }))
            : fetch(url, init, options),
    );
    await open();
    click("[data-segment-btn]:last-child");
    await settle();
    const row = query('[data-memory-run="failed"]')!;
    expect(row.textContent).toContain(language.structuredMemory.log.range(2, 5, 2));
    expect(row.textContent).toContain(language.structuredMemory.receipt.tokens(23, 17));
    expect(row.textContent).toContain(language.structuredMemory.log.seconds(1250));
    expect(row.textContent).toContain("provider failure");
    expect(row.textContent).toContain(literal);
    click("[data-memory-run] button");
    const quotes = [...row.querySelectorAll("blockquote")];
    expect(quotes.map((quote) => quote.dataset.memoryQuote)).toEqual([undefined, undefined, "unverified"]);
    expect(quotes.map((quote) => quote.previousElementSibling?.textContent?.trim())).toEqual([
        "Speaker",
        "door / state: closed → open",
        expect.stringContaining("the fact"),
    ]);
    expect(row.textContent).toContain("Extracted title");
    expect(row.textContent).toContain("**summary**");
    expect(row.querySelector("img, strong")).toBeNull();
    const exportButton = [...target.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === language.structuredMemory.log.export,
    )!;
    exportButton.click();
    await settle();
    expect(io.downloadFile).toHaveBeenCalledTimes(1);
    const [name, bytes] = io.downloadFile.mock.calls[0];
    expect(name).toMatch(/\.json$/);
    expect(JSON.parse(new TextDecoder().decode(bytes as Uint8Array))).toEqual({
        logVersion: expect.any(Number),
        revision: "export-revision",
        runs: [run],
    });
});

it("restarts Log pagination on a changed revision without keeping older rows", async () => {
    const fetch = io.authFetch.getMockImplementation()!;
    let requests = 0;
    io.authFetch.mockImplementation((url, init, options) => {
        if (!url.includes("/runs")) return fetch(url, init, options);
        requests++;
        return Promise.resolve(
            requests === 1
                ? Response.json(logRound("discarded", 1))
                : requests === 2
                  ? Response.json({ revision: "r2" }, { status: 409 })
                  : Response.json(logRound("replacement", null, "r2")),
        );
    });
    await open();
    click("[data-segment-btn]:last-child");
    await settle();
    const more = [...target.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === language.structuredMemory.log.loadMore,
    )!;
    more.click();
    await settle();
    expect(reads("runs").map(([url]) => url)).toEqual([
        "/api/memory/structured/c/k/runs?cursor=0",
        "/api/memory/structured/c/k/runs?cursor=1&revision=r1",
        "/api/memory/structured/c/k/runs?cursor=0",
    ]);
    expect(target.textContent).toContain("replacement");
    expect(target.textContent).not.toContain("discarded");
    expect(target.querySelectorAll("[data-memory-run]")).toHaveLength(1);
});

it("App mounts the structured panel only for structuredMemory and keeps the legacy modal for another algorithm", async () => {
    loadedStore.set(false);
    const { default: App } = await import("../../../App.svelte");
    instance = mount(App, { target });
    flushSync();
    await settle();
    expect(query('[data-memory-panel="coverage"]')).not.toBeNull();
    expect(query("[data-risu-memory-task]")).toBeNull();
    settings.ui.memoryAlgorithmType = "hypaV3";
    flushSync();
    await settle();
    expect(query("[data-memory-panel]")).toBeNull();
    expect(query("[data-risu-memory-task]")).not.toBeNull();
});

const context = (memory: ContextReport["memory"]): ContextReport => ({
    v: 1,
    maxContext: 1000,
    maxResponse: 100,
    input: 300,
    sections: [],
    adjustment: 300,
    attributionExact: true,
    history: { total: 8, kept: 4, totalUser: 4, keptUser: 2, droppedTokens: 100 },
    lore: { budgetUsed: 0, budget: 0, rejectedCount: 0, rejectedTokens: 0, active: 0 },
    tokenScope: "scope",
    historyDigest: "digest",
    memory,
});
const included = (id: string, verified = true) => ({
    id,
    kind: "event" as const,
    lane: "flow" as const,
    tokens: 20,
    reason: "recent",
    verified,
});
const memoryReport = (items: NonNullable<ContextReport["memory"]>["items"] = [included("used")]) =>
    context({ kind: "structuredMemory", tokens: 80, coverage: "covered", items });

it("badges only verified events from the newest valid report on Coverage rows, closed groups and committed Log runs", async () => {
    const ids = ["used", "unverified", "page", "older"];
    install([
        ...ids.flatMap((id) => [message(`${id}-u`, "user"), message(`${id}-a`, "char")]),
        {
            ...message("latest", "char"),
            generationInfo: {
                context: memoryReport([
                    included("used"),
                    included("unverified", false),
                    { ...included("page"), kind: "page" },
                ] as NonNullable<ContextReport["memory"]>["items"]),
            },
        } as Message,
        { ...message("malformed", "char"), generationInfo: { context: { v: 99 } } } as unknown as Message,
    ]);
    patchMessage(ref, "older-a", { generationInfo: { context: memoryReport([included("older")]) } });
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) => {
        if (url.includes("/coverage"))
            return Promise.resolve(
                Response.json({
                    revision: "r1",
                    runs: [],
                    next: null,
                    events: ids.map((id) => ({ id, title: id, status: "active", messageIds: [`${id}-u`, `${id}-a`] })),
                }),
            );
        if (url.includes("/runs"))
            return Promise.resolve(
                Response.json({
                    revision: "r1",
                    total: 4,
                    next: null,
                    runs: ids.map((eventId) => ({
                        id: `run-${eventId}`,
                        eventId,
                        model: eventId,
                        result: "recorded",
                        window: [],
                        analysis: { event: { id: "different-extracted-id", title: "Extraction" } },
                    })),
                }),
            );
        return fetch(url, init, options);
    });
    await open();
    const group = query('[data-memory-coverage-group="covered"]')!;
    expect(group.querySelectorAll("[data-memory-used]")).toHaveLength(1);
    click('[data-memory-coverage-group="covered"]');
    expect(group.querySelector("[data-memory-used]")).toBeNull();
    const badgedRows = () =>
        [...target.querySelectorAll("[data-memory-coverage-row]")].filter((row) =>
            row.querySelector("[data-memory-used]"),
        );
    expect(badgedRows()).toHaveLength(2);
    expect(badgedRows().map((row) => row.textContent)).toEqual([
        expect.stringContaining("used-u"),
        expect.stringContaining("used-a"),
    ]);
    click("[data-segment-btn]:last-child");
    await settle();
    const runs = [...target.querySelectorAll("[data-memory-run]")];
    expect(runs.map((row) => !!row.querySelector("[data-memory-used]"))).toEqual([true, false, false, false]);
    // A newer valid report of another kind stops the search; the older structured reports remain stored.
    patchMessage(ref, "malformed", {
        generationInfo: { context: context({ kind: "hypaV3", tokens: 20, coverage: "covered" }) },
    });
    await settle();
    expect(target.querySelectorAll("[data-memory-used]")).toHaveLength(0);
    click("[data-segment-btn]:first-of-type");
    await settle();
    expect(target.querySelectorAll("[data-memory-used]")).toHaveLength(0);
    click('[data-memory-coverage-group="covered"]');
    expect(target.querySelectorAll("[data-memory-used]")).toHaveLength(0);
});

const previewAnswer = (result: unknown): Awaited<ReturnType<typeof io.runServerJob>> => ({
    outcome: "started",
    terminal: { type: "done", epoch: "e", revision: null, result },
});

it("runs Preview only on its button and keeps the final tagged block and manifest across its own fence refresh", async () => {
    const pending = deferred<Awaited<ReturnType<typeof io.runServerJob>>>();
    releases.push(() => pending.resolve(previewAnswer({ messages: [], context: memoryReport() })));
    io.runServerJob.mockReturnValueOnce(pending.promise);
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url === "/api/memory/structured/c/k"
            ? Promise.resolve(
                  Response.json({
                      revision: "r1",
                      pages: [],
                      threads: [],
                      runs: [],
                      events: [{ id: "used", title: "Remembered promise" }],
                  }),
              )
            : fetch(url, init, options),
    );
    await open();
    click("[data-segment-btn]:nth-of-type(2)");
    await settle();
    click("[data-memory-panel-refresh]");
    await settle();
    expect(io.runServerJob).not.toHaveBeenCalled();
    click("[data-memory-preview-run]");
    await settle();
    expect(io.runServerJob).toHaveBeenCalledTimes(1);
    expect(io.runServerJob.mock.calls[0][1]).toEqual(ref);
    expect(io.runServerJob.mock.calls[0][2]).toMatchObject({ kind: "preview", context: { input: "" } });
    expect(query("[data-memory-panel-read-only]")).not.toBeNull();
    const messages = [
        { role: "system", content: "[m:flow:used] <b>A promise</b>" },
        { role: "system", content: "An unrelated old memory", memo: "supaMemory" },
        { role: "user", content: "Next question" },
    ];
    pending.resolve(previewAnswer({ messages, context: memoryReport() }));
    await settle();
    expect(query("[data-memory-panel-read-only]")).toBeNull();
    expect([...target.querySelectorAll("[data-memory-preview-entry]")].map((row) => row.textContent?.trim())).toEqual([
        "[m:flow:used] <b>A promise</b>",
    ]);
    expect(query("[data-memory-preview-block] b")).toBeNull();
    expect(query("[data-memory-manifest-item]")?.textContent).toContain("Remembered promise");
    expect(query('[data-memory-manifest-verified="true"]')).not.toBeNull();
    click("[data-memory-panel-refresh]");
    await settle();
    expect(io.runServerJob).toHaveBeenCalledTimes(1);
    expect(query("[data-memory-preview-entry]")).not.toBeNull();
    // Both public preview consumers still unpack the server's new result envelope.
    io.runServerJob.mockResolvedValue(previewAnswer({ messages, context: memoryReport() }));
    expect(await previewChat("preview", ref)).toEqual(messages);
    expect(await previewChatReport(ref)).toEqual({ messages, report: memoryReport() });
    io.runServerJob.mockResolvedValue(previewAnswer({ messages, context: { v: 99 } }));
    expect(await previewChatReport(ref)).toEqual({ messages, report: null });
});

it("never displays a pending preview's answer after the user switches chats", async () => {
    const pending = deferred<Awaited<ReturnType<typeof io.runServerJob>>>();
    releases.push(() => pending.resolve(previewAnswer({ messages: [], context: memoryReport() })));
    io.runServerJob.mockReturnValueOnce(pending.promise);
    io.authFetch.mockImplementation(async (url) => {
        if (url === "/api/memory/structured/c/k")
            return Response.json({ revision: "r1", pages: [], events: [], threads: [], runs: [] });
        throw new Error(`Unexpected request: ${url}`);
    });
    const selectedRef = writable(ref);
    const state = fromStore(selectedRef);
    instance = mount(PreviewTab, {
        target,
        props: {
            get chatRef() {
                return state.current;
            },
            readOnly: false,
            refresh: 0,
        },
    });
    flushSync();
    click("[data-memory-preview-run]");
    await settle();
    selectedRef.set({ chaId: "c", chatId: "other" });
    selectChat("c", "other");
    await settle();
    pending.resolve(
        previewAnswer({
            messages: [{ role: "system", content: "[m:flow:used] Foreign memory" }],
            context: memoryReport(),
        }),
    );
    await settle();
    expect(query("[data-memory-preview]")).not.toBeNull();
    expect(query("[data-memory-preview-block]")).toBeNull();
    expect(query("[data-memory-manifest]")).toBeNull();
    expect(target.textContent).not.toContain("Foreign memory");
    expect(io.runServerJob).toHaveBeenCalledTimes(1);
});
