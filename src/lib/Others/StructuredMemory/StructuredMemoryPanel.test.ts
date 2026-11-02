// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { fromStore, get, writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContextReport } from "../../../../shared/contextReport.ts";
import { previewChat, previewChatReport } from "src/ts/process/index.svelte";
import type { Chat, Message } from "../../../../shared/database.ts";
import { language } from "src/lang";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    findChat,
    hydrateChat,
    seedChats,
    selectChat,
    setMessageText,
    patchMessage,
    hasChatWork,
    takeChatWork,
    ackChatWork,
} from "src/ts/storage/chatStore.svelte";
import { selection, setChatOpen, selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { hypaV3ModalOpen, loadedStore } from "src/ts/stores.svelte";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { followedJobs } from "src/ts/process/serverCommands";
import { noteMemoryTaskFrame, resetMemoryTasks } from "src/ts/process/memoryTasks.svelte";
import { alertConfirm, alertError, alertToast } from "src/ts/alert";
import { pendingMessageJump } from "src/ts/messageSearch.svelte";
import { memoryMessageHash } from "src/ts/process/structuredMemory.svelte";
import {
    ADOPTED_WRITER_RUN,
    sealHypaV3Data,
    STRUCTURED_MEMORY_LIMITS,
    type MemoryEvent,
    type MemoryPage,
    type MemoryThread,
    type StructuredMemoryContentsAnswer,
} from "../../../../shared/structuredMemory.ts";
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
    hypaV3Data?: Chat["hypaV3Data"],
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
                    { id: "k", name: "K", note: "", localLore: [], message: messages, hypaV3Data },
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
        if (url.includes("/cost")) return Response.json({ calls: 1, messages: 2, estimatedTokens: 1700 });
        throw new Error(`Unexpected request: ${url}`);
    });
    io.runServerJob.mockReset();
    vi.mocked(alertError).mockClear();
    vi.mocked(alertToast).mockClear();
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
    expect(target.querySelectorAll("[data-segment-btn]")).toHaveLength(6);
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

const editablePage = (): MemoryPage => ({
    id: "p",
    title: "The gate",
    type: "location",
    aliases: [],
    contextMode: "auto",
    sections: [
        {
            heading: "Facts",
            body: "Original memory",
            provenance: ["event"],
            sources: [{ messageId: "u0", hash: "hash", index: 0 }],
            locked: true,
            updatedAt: 1,
        },
    ],
    history: [],
    links: [],
    retrieval: { keywords: [] },
});
const editableThread = (): MemoryThread => ({
    id: "t",
    title: "A promise",
    state: "done",
    who: ["p"],
    openedBy: "event",
    closedBy: "event",
});
function serveMemory() {
    const state = {
        page: editablePage(),
        thread: editableThread(),
        revision: "read-revision",
        runs: [] as { id: string; result: string }[],
    };
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation(async (url, init, options) => {
        if (url === "/api/memory/structured/c/k")
            return Response.json({
                revision: state.revision,
                pages: [
                    { id: "p", title: "The gate", type: "location", bytes: 100 },
                    { id: "scene", title: "Current scene", type: "scene", bytes: 100 },
                ],
                events: [{ id: "event", title: "Opening", status: "active", bytes: 100 }],
                threads: [{ id: "t", title: "A promise", state: state.thread.state, bytes: 100 }],
                runs: state.runs,
            });
        if (url.endsWith("/records/pages/p")) return Response.json({ revision: state.revision, data: state.page });
        if (url.endsWith("/records/pages/scene"))
            return Response.json({
                revision: state.revision,
                data: { ...state.page, id: "scene", type: "scene", contextMode: "always" },
            });
        if (url.endsWith("/records/threads/t")) return Response.json({ revision: state.revision, data: state.thread });
        if (url.endsWith("/records/events/event"))
            return Response.json({
                revision: state.revision,
                data: { id: "event", summary: "The gate opened", participants: ["p"] },
            });
        return fetch(url, init, options);
    });
    return state;
}
async function chooseTab(name: "pages" | "timeline" | "threads") {
    const button = [...target.querySelectorAll<HTMLButtonElement>("[data-segment-btn]")].find(
        (button) => button.textContent?.trim() === language.structuredMemory.panel[name],
    );
    expect(button).toBeDefined();
    button!.click();
    await settle();
    expect(query(`[data-memory-panel="${name}"]`)).not.toBeNull();
}
function press(selector: string) {
    const button = query(selector)?.closest("button");
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    button!.click();
    flushSync();
}
function changeSelect(selector: string, value: string) {
    const input = target.querySelector<HTMLSelectElement>(selector)!;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(false);
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
}
function typeSection(value: string) {
    const input = target.querySelector("textarea")!;
    expect(input).not.toBeNull();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}
const sentEdits = () => reads("edits").map(([, init]) => JSON.parse(init!.body as string));

it("sends one page change with the copy revision and uses each successful answer for the next edit", async () => {
    const state = serveMemory();
    const fetch = io.authFetch.getMockImplementation()!;
    const corrected = {
        ...state.page,
        sections: [{ ...state.page.sections[0], body: "Corrected memory", userCorrected: true }],
    };
    const unlocked = { ...corrected, sections: [{ ...corrected.sections[0], locked: false }] };
    const hidden = { ...unlocked, contextMode: "never" };
    const answers = [corrected, unlocked, hidden, { ...hidden, grade: 3, gradeByUser: true }, hidden];
    let index = 0;
    io.authFetch.mockImplementation((url, init, options) =>
        url.endsWith("/edits")
            ? Promise.resolve(Response.json({ revision: `saved-${++index}`, kind: "pages", data: answers[index - 1] }))
            : fetch(url, init, options),
    );
    await open();
    await chooseTab("pages");
    expect(
        [...target.querySelectorAll<HTMLElement>("[data-memory-page]")].map((row) => row.dataset.memoryPage),
    ).toEqual(["scene", "p"]);
    click('[data-memory-page="scene"]');
    await settle();
    expect(query("[data-memory-page-mode]")).toBeNull();
    click('[data-memory-page="p"]');
    await settle();
    press("[data-memory-section-edit]");
    typeSection(" \n");
    expect(query("[data-memory-section-save]")!.closest("button")!.disabled).toBe(true);
    typeSection("x".repeat(STRUCTURED_MEMORY_LIMITS.sectionBodyChars + 1));
    expect(query("[data-memory-section-save]")!.closest("button")!.disabled).toBe(true);
    typeSection("Corrected memory");
    press("[data-memory-section-save]");
    await settle();
    expect(query("textarea")).toBeNull();
    expect(query("[data-memory-section-body]")?.textContent).toBe("Corrected memory");
    click('[data-memory-section] input[type="checkbox"]');
    await settle();
    changeSelect("[data-memory-page-mode]", "never");
    await settle();
    changeSelect("[data-memory-page-grade]", "3");
    await settle();
    changeSelect("[data-memory-page-grade]", "");
    await settle();
    expect(sentEdits()).toEqual([
        {
            revision: "read-revision",
            edit: { kind: "section", pageId: "p", heading: "Facts", body: "Corrected memory" },
        },
        { revision: "saved-1", edit: { kind: "sectionLock", pageId: "p", heading: "Facts", locked: false } },
        { revision: "saved-2", edit: { kind: "page", pageId: "p", contextMode: "never" } },
        { revision: "saved-3", edit: { kind: "page", pageId: "p", grade: 3 } },
        { revision: "saved-4", edit: { kind: "page", pageId: "p", grade: null } },
    ]);
});

it.each(["pages", "threads"] as const)(
    "undoes a refused %s edit, gives notice, rereads and retains the next successful revision",
    async (tab) => {
        const state = serveMemory();
        const refusal = deferred<Response>();
        const reread = deferred<Response>();
        const fetch = io.authFetch.getMockImplementation()!;
        let holdingRead = false;
        let edits = 0;
        io.authFetch.mockImplementation((url, init, options) => {
            if (url.endsWith("/edits")) {
                edits++;
                if (edits === 1) return refusal.promise;
                return Promise.resolve(
                    Response.json({
                        revision: "success-revision",
                        kind: tab,
                        data:
                            tab === "pages"
                                ? { ...state.page, contextMode: edits === 2 ? "never" : "auto" }
                                : { ...state.thread, state: edits === 2 ? "open" : "done", closedBy: undefined },
                    }),
                );
            }
            if (
                holdingRead &&
                (tab === "pages" ? url.endsWith("/records/pages/p") : url === "/api/memory/structured/c/k")
            )
                return reread.promise;
            return fetch(url, init, options);
        });
        await open();
        await chooseTab(tab);
        if (tab === "pages") {
            click('[data-memory-page="p"]');
            await settle();
        } else {
            click("[data-memory-thread] button");
            await settle();
        }
        const selector = tab === "pages" ? "[data-memory-page-mode]" : "[data-memory-thread-state]";
        const value = () => target.querySelector<HTMLSelectElement>(selector)!.value;
        const before = tab === "pages" ? "auto" : "done";
        const attempted = tab === "pages" ? "never" : "open";
        changeSelect(selector, attempted);
        expect(value()).toBe(attempted);
        expect(target.querySelector<HTMLSelectElement>(selector)!.disabled).toBe(true);
        holdingRead = true;
        const reason = tab === "pages" ? "changed" : "fenced";
        refusal.resolve(Response.json({ reason, revision: "newer" }, { status: 409 }));
        await settle();
        expect(value()).toBe(before);
        expect(alertError).toHaveBeenCalledWith(language.structuredMemory.panel.readRefused[reason]);
        expect(
            io.authFetch.mock.calls.filter(([url]) =>
                tab === "pages" ? url.endsWith("/records/pages/p") : url === "/api/memory/structured/c/k",
            ).length,
        ).toBeGreaterThanOrEqual(2);
        reread.resolve(
            Response.json(
                tab === "pages"
                    ? { revision: "reread-revision", data: state.page }
                    : {
                          revision: "reread-revision",
                          pages: [],
                          events: [],
                          runs: [],
                          threads: [{ ...state.thread, bytes: 100 }],
                      },
            ),
        );
        await settle();
        changeSelect(selector, attempted);
        await settle();
        expect(value()).toBe(attempted);
        changeSelect(selector, before);
        await settle();
        const edit = (value: string) =>
            tab === "pages"
                ? { kind: "page", pageId: "p", contextMode: value }
                : { kind: "thread", threadId: "t", state: value };
        expect(sentEdits()).toEqual([
            { revision: "read-revision", edit: edit(attempted) },
            { revision: "reread-revision", edit: edit(attempted) },
            { revision: "success-revision", edit: edit(before) },
        ]);
    },
);

it("closes an overtaken section draft with a changed notice when the writer fence falls", async () => {
    const state = serveMemory();
    await open();
    await chooseTab("pages");
    click('[data-memory-page="p"]');
    await settle();
    press("[data-memory-section-edit]");
    typeSection("My unsaved draft");
    const release = beginLocalSend(ref)!;
    releases.push(release);
    await settle();
    expect(target.querySelector("textarea")!.value).toBe("My unsaved draft");
    expect(query("[data-memory-section-save]")!.closest("button")!.disabled).toBe(true);
    state.revision = "writer-revision";
    state.page = { ...state.page, sections: [{ ...state.page.sections[0], body: "New writer text" }] };
    release();
    await settle();
    expect(query("textarea")).toBeNull();
    expect(query("[data-memory-section-body]")?.textContent).toBe("New writer text");
    expect(alertError).toHaveBeenCalledWith(language.structuredMemory.panel.readRefused.changed);
    expect(sentEdits()).toEqual([]);
});

it("badges only verified Pages and Timeline records from the newest valid report", async () => {
    install([
        message("u0", "user"),
        message("a0", "char"),
        message("u1", "user"),
        message("a1", "char"),
        message("invalid", "char"),
    ]);
    serveMemory();
    patchMessage(ref, "a0", {
        generationInfo: { context: memoryReport([{ ...included("scene"), kind: "page" }, included("older")]) },
    });
    patchMessage(ref, "a1", {
        generationInfo: {
            context: memoryReport([
                included("event"),
                included("unverified", false),
                { ...included("p"), kind: "page" },
                { ...included("scene", false), kind: "page" },
            ]),
        },
    });
    // An invalid later report does not hide the newest valid one.
    patchMessage(ref, "invalid", { generationInfo: { context: { v: 99 } as unknown as ContextReport } });
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url.includes("/coverage")
            ? Promise.resolve(
                  Response.json({
                      revision: "r1",
                      runs: [],
                      next: null,
                      events: ["older", "unverified", "event", "p"].map((id) => ({
                          id,
                          title: id,
                          status: "active",
                          messageIds: ["u0"],
                      })),
                  }),
              )
            : fetch(url, init, options),
    );
    await open();
    await chooseTab("pages");
    const badged = (selector: string, attribute: string) =>
        [...target.querySelectorAll(selector)]
            .filter((row) => row.querySelector("[data-memory-used]"))
            .map((row) => row.getAttribute(attribute));
    expect(badged("[data-memory-page]", "data-memory-page")).toEqual(["p"]);
    await chooseTab("timeline");
    expect(badged("[data-memory-event]", "data-memory-event")).toEqual(["event"]);
    patchMessage(ref, "a1", {
        generationInfo: { context: context({ kind: "hypaV3", tokens: 10, coverage: "covered" }) },
    });
    await settle();
    expect(query("[data-memory-used]")).toBeNull();
    await chooseTab("pages");
    expect(query("[data-memory-used]")).toBeNull();
});

it("follows record links between tabs and opens the chat and closes the panel for a message link", async () => {
    serveMemory();
    setChatOpen(false);
    await open();
    await chooseTab("threads");
    click("[data-memory-thread] button");
    await settle();
    click('[data-memory-link="p"]');
    await settle();
    expect(query('[data-memory-panel="pages"]')).not.toBeNull();
    expect(query('[data-memory-page="p"]')?.getAttribute("aria-current")).toBe("true");
    expect(query("[data-memory-section-body]")?.textContent).toBe("Original memory");
    click('[data-memory-provenance="event"]');
    await settle();
    expect(query('[data-memory-panel="timeline"]')).not.toBeNull();
    expect(query('[data-memory-event="event"] button')?.getAttribute("aria-expanded")).toBe("true");
    expect(target.textContent).toContain("The gate opened");
    click('[data-memory-participant="p"]');
    await settle();
    expect(query('[data-memory-page="p"]')?.getAttribute("aria-current")).toBe("true");
    click('[data-memory-source="u0"]');
    expect(selection.chatOpen).toBe(true);
    expect(pendingMessageJump()).toMatchObject({ ref, messageId: "u0" });
    expect(get(hypaV3ModalOpen)).toBe(false);
    setChatOpen(false);
    hypaV3ModalOpen.set(true);
    await chooseTab("timeline");
    click('[data-memory-event="event"] button');
    await settle();
    click('[data-memory-source="u0"]');
    expect(selection.chatOpen).toBe(true);
    expect(pendingMessageJump()).toMatchObject({ ref, messageId: "u0" });
    expect(get(hypaV3ModalOpen)).toBe(false);
});

it("derives the writer line from current state and dispatches record and resume through the job client", async () => {
    install([
        message("u0", "user"),
        message("a0", "char"),
        message("u1", "user"),
        message("a1", "char"),
        message("latest-question", "user"),
    ]);
    const state = serveMemory();
    const owner = characterList().find(({ chaId }) => chaId === "c")!;
    const action = () => query("[data-memory-writer-action]");
    const line = () => query("[data-memory-writer-line]");
    io.runServerJob.mockResolvedValue(previewAnswer({}));
    await open();
    expect(action()?.dataset.memoryWriterAction).toBe("record");
    press("[data-memory-writer-action]");
    await settle();
    expect(io.runServerJob.mock.calls[0]).toEqual([
        owner,
        ref,
        {
            kind: "command",
            command: { type: "memoryRecord", messageId: "a1" },
            label: "memoryRecord",
            context: { mode: "manual" },
        },
    ]);
    settings.hypaV3Presets.items[0].settings.structured!.cadence = "manual";
    await settle();
    expect(line()?.textContent).toContain(language.structuredMemory.notAutomaticReasons.manual);
    patchMessage(ref, "a1", { generationInfo: { memory: { state: "notAutomatic", reason: "pluginModel" } } });
    await settle();
    expect(line()?.textContent).toContain(language.structuredMemory.notAutomaticReasons.pluginModel);
    state.runs = Array.from({ length: STRUCTURED_MEMORY_LIMITS.consecutiveFailures }, (_, i) => ({
        id: String(i),
        result: "failed",
    }));
    click("[data-memory-panel-refresh]");
    await settle();
    expect(action()?.dataset.memoryWriterAction).toBe("resume");
    press("[data-memory-writer-action]");
    await settle();
    expect(io.runServerJob.mock.calls[1]).toEqual([
        owner,
        ref,
        {
            kind: "command",
            command: { type: "memoryRecord" },
            label: "memoryRecord",
            context: { mode: "manual" },
        },
    ]);
    state.runs = [];
    patchMessage(ref, "a1", { generationInfo: { memory: { state: "skipped", reason: "writerPaused" } } });
    click("[data-memory-panel-refresh]");
    await settle();
    expect(action()?.dataset.memoryWriterAction).toBe("resume");
    const release = beginLocalSend(ref)!;
    releases.push(release);
    await settle();
    expect(action()!.closest("button")!.disabled).toBe(true);
    action()!.closest("button")!.click();
    expect(io.runServerJob).toHaveBeenCalledTimes(2);
    release();
    owner.supaMemory = false;
    await settle();
    expect(line()?.dataset.memoryWriterLine).toBe("memoryOff");
    expect(action()).toBeNull();
});

/** Coverage, record and edit I/O for the real Timeline; anchors come from the initial held chat. */
function serveAnchoredEvent() {
    const messages = findChat(ref)!.message;
    const event: MemoryEvent = {
        id: "e",
        title: "Gate opened",
        summary: "The gate opened",
        status: "active",
        sources: messages.slice(0, 2).map((m, index) => ({ messageId: m.chatId!, index, hash: memoryMessageHash(m) })),
        participants: [],
        storyTime: { text: "" },
        keyLines: [],
        stateChanges: [],
        knowledge: [],
        relationshipShifts: [],
        openThreads: { add: [], close: [], transitions: [] },
        writerRun: "r",
        createdRevision: 1,
    };
    const state = { event, revision: "seen-revision" };
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation(async (url, init, options) => {
        if (url.includes("/coverage"))
            return Response.json({
                revision: state.revision,
                events: [{ ...state.event, messageIds: ["u0", "a0"], sourceIndex: 0 }],
                runs: [],
                next: null,
            });
        if (url.endsWith("/records/events/e")) return Response.json({ revision: state.revision, data: state.event });
        if (url === "/api/memory/structured/c/k")
            return Response.json({
                revision: state.revision,
                events: [{ id: "e", title: state.event.title, status: state.event.status, bytes: 100 }],
                pages: [],
                threads: [],
                runs: [],
            });
        return fetch(url, init, options);
    });
    return state;
}

it("moves edited held sources from covered to stale in Coverage and Timeline without rereading memory", async () => {
    serveAnchoredEvent();
    await open();
    expect(query('[data-memory-coverage-count="covered"]')?.textContent).toContain("2");
    const requests = reads().length;
    setMessageText(ref, "a0", "Edited reply");
    await settle();
    expect(query('[data-memory-coverage-count="stale"]')?.textContent).toContain("2");
    expect(query('[data-memory-coverage-count="covered"]')?.textContent).toContain("0");
    click('[data-memory-coverage-group="stale"]');
    expect(query('[data-memory-coverage-row="stale"]')?.textContent).toContain(
        language.structuredMemory.coverage.reasons.changed,
    );
    expect(query("[data-memory-coverage-leaving]")?.textContent).toContain(
        language.structuredMemory.coverage.leaving(1, 0, language.structuredMemory.coverage.aboutTokens(0)),
    );
    expect(reads()).toHaveLength(requests);
    await chooseTab("timeline");
    expect(query('[data-memory-event="e"]')?.dataset.memoryEventStatus).toBe("stale");
    expect(query('[data-memory-event-badge="stale"]')?.textContent).toContain(
        language.structuredMemory.coverage.reasons.changed,
    );
    const timelineReads = io.authFetch.mock.calls.length;
    setMessageText(ref, "a0", "a0");
    await settle();
    expect(query('[data-memory-event="e"]')?.dataset.memoryEventStatus).toBe("active");
    setMessageText(ref, "a0", "Another edit");
    await settle();
    expect(query('[data-memory-event="e"]')?.dataset.memoryEventStatus).toBe("stale");
    expect(io.authFetch).toHaveBeenCalledTimes(timelineReads);
});

it("sends the seen keep state, explains a refusal, and confirms before retracting a stale event", async () => {
    const state = serveAnchoredEvent();
    setMessageText(ref, "a0", "Edited reply");
    const fetch = io.authFetch.getMockImplementation()!;
    let edits = 0;
    io.authFetch.mockImplementation(async (url, init, options) => {
        if (!url.endsWith("/edits")) return fetch(url, init, options);
        edits++;
        if (edits === 1) {
            state.revision = "fresh-revision";
            return Response.json({ reason: "changed", error: "Chat moved on" }, { status: 409 });
        }
        state.event = { ...state.event, status: "retracted" };
        state.revision = "retired-revision";
        return Response.json({ revision: state.revision, kind: "events", data: state.event });
    });
    await open();
    await chooseTab("timeline");
    click('[data-memory-event="e"] > button');
    await settle();
    const held = findChat(ref)!.message;
    const expectedState = JSON.stringify([
        ["u0", memoryMessageHash(held[0]), 0],
        ["a0", memoryMessageHash(held[1]), 1],
    ]);
    press('[data-memory-repair="keep"]');
    await settle();
    expect(sentEdits()).toEqual([
        { revision: "seen-revision", edit: { kind: "event", eventId: "e", repair: "keep", state: expectedState } },
    ]);
    expect(alertError).toHaveBeenCalledWith(language.structuredMemory.panel.readRefused.changed);
    expect(query('[data-memory-event="e"]')?.dataset.memoryEventStatus).toBe("stale");
    vi.mocked(alertConfirm).mockResolvedValueOnce(false);
    press('[data-memory-repair="retract"]');
    await settle();
    expect(sentEdits()).toHaveLength(1);
    const confirmation = deferred<boolean>();
    vi.mocked(alertConfirm).mockReturnValueOnce(confirmation.promise);
    press('[data-memory-repair="retract"]');
    await settle();
    expect(sentEdits()).toHaveLength(1);
    expect(alertConfirm).toHaveBeenLastCalledWith(language.structuredMemory.timeline.repairs.retractConfirm);
    confirmation.resolve(true);
    await settle();
    expect(sentEdits()[1]).toEqual({
        revision: "fresh-revision",
        edit: { kind: "event", eventId: "e", repair: "retract" },
    });
    expect(query('[data-memory-event="e"]')?.dataset.memoryEventStatus).toBe("retracted");
    expect(query("[data-memory-event-repairs]")).toBeNull();
});

it("marks before pressing rerecord, retries a marked event, and disables it when the last eligible source is a user", async () => {
    const state = serveAnchoredEvent();
    setMessageText(ref, "a0", "Edited reply");
    const marked = deferred<Response>();
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url.endsWith("/edits") ? marked.promise : fetch(url, init, options),
    );
    io.runServerJob.mockResolvedValue(previewAnswer({}));
    await open();
    await chooseTab("timeline");
    click('[data-memory-event="e"] > button');
    await settle();
    press('[data-memory-repair="rerecord"]');
    await settle();
    expect(sentEdits()).toEqual([
        { revision: "seen-revision", edit: { kind: "event", eventId: "e", repair: "rerecord" } },
    ]);
    expect(io.runServerJob).not.toHaveBeenCalled();
    state.event = { ...state.event, rerecord: true };
    state.revision = "marked-revision";
    marked.resolve(Response.json({ revision: state.revision, kind: "events", data: state.event }));
    await settle();
    expect(io.runServerJob.mock.calls[0][2]).toMatchObject({
        kind: "command",
        command: { type: "memoryRecord", messageId: "a0" },
    });
    expect(query('[data-memory-event-badge="rerecord"]')).not.toBeNull();
    press('[data-memory-repair="rerecord"]');
    await settle();
    expect(sentEdits()).toHaveLength(1);
    expect(io.runServerJob).toHaveBeenCalledTimes(2);
    patchMessage(ref, "a0", { disabled: true });
    await settle();
    const button = query('[data-memory-repair="rerecord"]')!.closest("button")!;
    expect(button.disabled).toBe(true);
    button.click();
    await settle();
    expect(io.runServerJob).toHaveBeenCalledTimes(2);
});

it("shows a send's stale reason in the panel manifest", async () => {
    serveAnchoredEvent();
    const context = memoryReport();
    context.memory = {
        kind: "structuredMemory",
        tokens: 0,
        coverage: "gap",
        items: [],
        excluded: [{ id: "e", kind: "event", lane: "events", reason: "stale", staleReason: "moved" }],
        excludedTotal: 1,
    };
    io.runServerJob.mockResolvedValue(previewAnswer({ messages: [], context }));
    await open();
    click("[data-segment-btn]:nth-of-type(2)");
    await settle();
    click("[data-memory-preview-run]");
    await settle();
    expect(query('[data-memory-manifest-excluded="stale"]')?.textContent).toContain("Gate opened");
    expect(query('[data-memory-manifest-stale-reason="moved"]')?.textContent).toBe(
        language.structuredMemory.coverage.reasons.moved,
    );
});

const heldSummaries = () => ({
    summaries: [{ text: "The gate opened.", chatMemos: ["u0", "a0"], isImportant: true }],
});
function holdHypaV3Data(hypaV3Data: Chat["hypaV3Data"]) {
    install(undefined, hypaV3Data);
    flushSync();
}
function serveAdoptionContents() {
    const contents: StructuredMemoryContentsAnswer = {
        revision: revision(1),
        pages: [],
        events: [],
        threads: [],
        runs: [{ id: "failed", result: "failed", bytes: 100 }],
        adoption: { adoptable: 1, declined: false, resettable: false },
        rebuild: null,
        recordedLanguage: null,
    };
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url === "/api/memory/structured/c/k" ? Promise.resolve(Response.json(contents)) : fetch(url, init, options),
    );
    return contents;
}

it("offers adoption only after the contents are read and only while the server says the chat waits, whatever the tab holds", async () => {
    holdHypaV3Data(heldSummaries());
    const contents = serveAdoptionContents();
    const pending = deferred<Response>();
    const fetch = io.authFetch.getMockImplementation()!;
    let contentsPending = true;
    io.authFetch.mockImplementation((url, init, options) => {
        if (url === "/api/memory/structured/c/k" && contentsPending) {
            contentsPending = false;
            return pending.promise;
        }
        return fetch(url, init, options);
    });
    await open();
    expect(query("[data-memory-adopt]")).toBeNull();
    pending.resolve(Response.json(contents));
    await settle();
    expect(query("[data-memory-adopt]")?.textContent).toContain("No model is called");
    io.authFetch.mockImplementation(fetch);
    contents.adoption.adoptable = 0;
    click("[data-memory-panel-refresh]");
    await settle();
    expect(query("[data-memory-adopt]")).toBeNull();
    contents.adoption.adoptable = 1;
    click("[data-memory-panel-refresh]");
    await settle();
    expect(query("[data-memory-adopt]")).not.toBeNull();
    for (const data of [sealHypaV3Data(heldSummaries()), { summaries: [] }, undefined]) {
        holdHypaV3Data(data);
        await settle();
        expect(query("[data-memory-adopt]")).not.toBeNull();
    }
});

it("disables adoption while read-only, posts once without a body, then toasts and rereads so the offer disappears", async () => {
    holdHypaV3Data(heldSummaries());
    const contents = serveAdoptionContents();
    const response = deferred<Response>();
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url.endsWith("/adopt") ? response.promise : fetch(url, init, options),
    );
    await open();
    const held = JSON.parse(JSON.stringify(findChat(ref)));
    const button = () => query("[data-memory-adopt-action]")!.closest("button")!;
    const release = beginLocalSend(ref)!;
    releases.push(release);
    flushSync();
    expect(button().disabled).toBe(true);
    button().click();
    await settle();
    expect(reads("adopt")).toHaveLength(0);
    release();
    await settle();
    expect(button().disabled).toBe(false);
    button().click();
    button().click();
    await settle();
    expect(button().disabled).toBe(true);
    expect(reads("adopt")).toHaveLength(1);
    const [url, init] = reads("adopt")[0];
    expect(url).toBe("/api/memory/structured/c/k/adopt");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    const coverageReads = reads().length;
    const contentsReads = io.authFetch.mock.calls.filter(([url]) => url === "/api/memory/structured/c/k").length;
    contents.events = [{ id: "adopted", title: "The gate opened.", status: "active", bytes: 100 }];
    contents.revision = revision(2);
    contents.adoption.adoptable = 0;
    response.resolve(Response.json({ revision: revision(2), adopted: 1, stale: 0 }));
    await settle();
    expect(alertToast).toHaveBeenCalledWith(language.structuredMemory.adopt.done(1, 0));
    expect(reads()).toHaveLength(coverageReads + 1);
    expect(io.authFetch.mock.calls.filter(([url]) => url === "/api/memory/structured/c/k")).toHaveLength(
        contentsReads + 1,
    );
    expect(query("[data-memory-adopt]")).toBeNull();
    expect(findChat(ref)).toEqual(held);
    expect(io.runServerJob).not.toHaveBeenCalled();
});

it("shows an adoption refusal without changing the held chat or showing a success toast", async () => {
    holdHypaV3Data(heldSummaries());
    serveAdoptionContents();
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) =>
        url.endsWith("/adopt")
            ? Promise.resolve(Response.json({ reason: "fenced", error: "Writer holds the chat" }, { status: 409 }))
            : fetch(url, init, options),
    );
    await open();
    const held = JSON.parse(JSON.stringify(findChat(ref)));
    press("[data-memory-adopt-action]");
    await settle();
    expect(reads("adopt")).toHaveLength(1);
    expect(alertError).toHaveBeenCalledWith(language.structuredMemory.panel.readRefused.fenced);
    expect(alertToast).not.toHaveBeenCalled();
    expect(findChat(ref)).toEqual(held);
    expect(query("[data-memory-adopt]")).not.toBeNull();
    expect(query("[data-memory-adopt-action]")?.closest("button")?.disabled).toBe(false);
    expect(io.runServerJob).not.toHaveBeenCalled();
});

it("shows Originally adopted only in an open event whose writer run is the adoption marker", async () => {
    const state = serveAnchoredEvent();
    state.event.writerRun = ADOPTED_WRITER_RUN;
    await open();
    await chooseTab("timeline");
    expect(query("[data-memory-event-adopted]")).toBeNull();
    click('[data-memory-event="e"] > button');
    await settle();
    expect(query("[data-memory-event-adopted]")?.textContent).toBe(language.structuredMemory.adopt.adoptedEvent);
    state.event.writerRun = "ordinary-writer-run";
    click('[data-memory-event="e"] > button');
    click('[data-memory-event="e"] > button');
    await settle();
    expect(query("[data-memory-event-adopted]")).toBeNull();
    expect(query('[data-memory-event="e"]')?.textContent).toContain("The gate opened");
});

it("places the adoption choice above the writer line and confirms decline before restoring Record now", async () => {
    holdHypaV3Data(heldSummaries());
    const contents = serveAdoptionContents();
    contents.runs = Array.from({ length: 5 }, (_, index) => ({ id: `failed-${index}`, result: "failed", bytes: 100 }));
    settings.hypaV3Presets.items[0].settings.structured!.cadence = "manual";
    patchMessage(ref, "a1", { generationInfo: { memory: { state: "notAutomatic", reason: "awaitingAdoption" } } });
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation((url, init, options) => {
        if (url.endsWith("/decline")) {
            contents.adoption = { adoptable: 0, declined: true, resettable: false };
            contents.runs = [];
            return Promise.resolve(Response.json({ revision: revision(2), declined: true }));
        }
        return fetch(url, init, options);
    });
    await open();
    expect(
        query("[data-memory-adopt]")!.compareDocumentPosition(query("[data-memory-writer-line]")!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(query("[data-memory-writer-line]")?.textContent).toContain(
        language.structuredMemory.notAutomaticReasons.awaitingAdoption,
    );
    expect(query("[data-memory-writer-action]")).toBeNull();
    vi.mocked(alertConfirm).mockResolvedValueOnce(false);
    press("[data-memory-decline-action]");
    await settle();
    expect(alertConfirm).toHaveBeenLastCalledWith(language.structuredMemory.adopt.declineConfirm);
    expect(reads("decline")).toHaveLength(0);
    expect(query("[data-memory-adopt]")).not.toBeNull();
    vi.mocked(alertConfirm).mockResolvedValueOnce(true);
    press("[data-memory-decline-action]");
    await settle();
    expect(reads("decline")).toHaveLength(1);
    expect(reads("decline")[0][1]).toMatchObject({ method: "POST" });
    expect(reads("decline")[0][1]?.body).toBeUndefined();
    expect(query("[data-memory-adopt]")).toBeNull();
    expect(query("[data-memory-writer-action]")?.dataset.memoryWriterAction).toBe("record");
    expect(query("[data-memory-writer-line]")?.textContent).toContain(
        language.structuredMemory.notAutomaticReasons.manual,
    );
    expect(findChat(ref)?.hypaV3Data).toEqual(heldSummaries());
});

it("shows Reset only on the server's offer, confirms it and refreshes held summaries without a chat write", async () => {
    for (const newerSummary of [false, true]) {
        holdHypaV3Data(heldSummaries());
        // Settle the fixture's previous edits as a completed server save before testing an idle refresh.
        const pending = takeChatWork(new Set());
        ackChatWork(
            pending,
            pending.groups.map(({ characterId, chatId }) => ({ characterId, id: chatId, revision: revision(1) })),
            [],
        );
        seedChats(
            [{ characterId: "c", id: "k", revision: revision(1) }],
            [{ characterId: "c", revision: revision(1), ids: ["k", "other"] }],
        );
        const original = JSON.parse(JSON.stringify(findChat(ref))) as Chat;
        const contents = serveAdoptionContents();
        contents.adoption = { adoptable: 0, declined: false, resettable: false };
        const replacement = newerSummary
            ? { summaries: [{ text: "Written after reset", chatMemos: ["a1"], isImportant: false }] }
            : sealHypaV3Data(heldSummaries(), revision(1));
        const fetch = io.authFetch.getMockImplementation()!;
        io.authFetch.mockImplementation((url, init, options) => {
            if (url.endsWith("/reset-summaries")) {
                contents.adoption.resettable = false;
                return Promise.resolve(Response.json({ chatRevision: revision(2), reset: true }));
            }
            if (url === "/api/resources/read")
                return Promise.resolve(
                    Response.json({
                        epoch,
                        items: [],
                        chats: [
                            {
                                characterId: "c",
                                id: "k",
                                revision: revision(newerSummary ? 3 : 2),
                                data: { ...original, hypaV3Data: replacement },
                            },
                        ],
                    }),
                );
            return fetch(url, init, options);
        });
        await open();
        expect(query("[data-memory-reset]")).toBeNull();
        contents.adoption.resettable = true;
        click("[data-memory-panel-refresh]");
        await settle();
        expect(query("[data-memory-reset]")).not.toBeNull();
        const requests = reads("reset-summaries").length;
        vi.mocked(alertConfirm).mockResolvedValueOnce(false);
        press("[data-memory-reset-action]");
        await settle();
        expect(alertConfirm).toHaveBeenLastCalledWith(language.structuredMemory.adopt.resetConfirm);
        expect(reads("reset-summaries")).toHaveLength(requests);
        expect(findChat(ref)?.hypaV3Data).toEqual(heldSummaries());
        expect(hasChatWork()).toBe(false);
        vi.mocked(alertConfirm).mockResolvedValueOnce(true);
        press("[data-memory-reset-action]");
        await settle();
        expect(reads("reset-summaries")).toHaveLength(requests + 1);
        expect(reads("reset-summaries").at(-1)![1]).toMatchObject({ method: "POST" });
        expect(reads("reset-summaries").at(-1)![1]?.body).toBeUndefined();
        expect(findChat(ref)?.hypaV3Data).toEqual(replacement);
        expect(hasChatWork()).toBe(false);
        expect(io.authFetch.mock.calls.filter(([url]) => url === "/api/resources/batch")).toEqual([]);
        expect(query("[data-memory-reset]")).toBeNull();
        await unmount(instance!);
        instance = undefined;
    }
});

function serveRebuildContents() {
    const state: StructuredMemoryContentsAnswer = {
        revision: "r1",
        pages: [],
        events: [],
        threads: [],
        runs: [],
        adoption: { adoptable: 0, declined: false, resettable: false },
        rebuild: null,
        recordedLanguage: "English",
    };
    const fetch = io.authFetch.getMockImplementation()!;
    io.authFetch.mockImplementation(async (url, init, options) => {
        if (url === "/api/memory/structured/c/k") return Response.json(state);
        if (url.includes("/cost?")) return Response.json({ calls: 1, messages: 2, estimatedTokens: 1700 });
        if (url === "/api/memory/tasks/c/k" && init?.method === "DELETE") return Response.json({ cancelled: true });
        if (url.endsWith("/rebuild/abandon")) {
            state.rebuild = null;
            return Response.json({ revision: "r1", abandoned: true });
        }
        return fetch(url, init, options);
    });
    return state;
}

it("offers a language rebuild without starting it and confirms both rebuild and fill gaps even for one call, hiding both while held", async () => {
    const state = serveRebuildContents();
    settings.hypaV3Presets.items[0].settings.structured!.language = "Korean";
    settings.hypaV3Presets.items[0].settings.structured!.cadence = "everyTurn";
    io.runServerJob.mockResolvedValue(previewAnswer({}));
    const confirm = vi.mocked(alertConfirm).mockReset().mockResolvedValue(false);
    await open();
    expect(query("[data-memory-rebuild-language]")?.textContent).toContain("English");
    expect(query("[data-memory-rebuild-language]")?.textContent).toContain("Korean");
    expect(io.runServerJob).not.toHaveBeenCalled();
    for (const mode of ["rebuild", "backfill"] as const) {
        confirm.mockResolvedValue(false);
        const prior = io.runServerJob.mock.calls.length;
        press(`[data-memory-rebuild-action="${mode}"]`);
        await settle();
        const text = language.structuredMemory.rebuild;
        expect(confirm).toHaveBeenLastCalledWith(
            mode === "rebuild" ? text.confirmRebuild(text.cost(1, 1700)) : text.confirmBackfill(text.cost(1, 1700)),
        );
        expect(io.runServerJob).toHaveBeenCalledTimes(prior);
        confirm.mockResolvedValue(true);
        press(`[data-memory-rebuild-action="${mode}"]`);
        await settle();
        expect(io.runServerJob).toHaveBeenLastCalledWith(
            characterList().find(({ chaId }) => chaId === "c"),
            ref,
            {
                kind: "command",
                command: { type: "memoryRebuild", mode, turns: 1 },
                label: "memoryRebuild",
                context: { mode: "manual" },
            },
        );
    }
    state.adoption.adoptable = 1;
    click("[data-memory-panel-refresh]");
    await settle();
    expect(query("[data-memory-rebuild-offer]")).toBeNull();
});

it("shows run progress and pause or resumable controls and always permits abandon while read-only", async () => {
    const state = serveRebuildContents();
    state.rebuild = { mode: "rebuild", done: 1, total: 5, resumable: true, reason: "cancelled" };
    io.runServerJob.mockResolvedValue(previewAnswer({}));
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(true);
    await open();
    expect(query("[data-memory-panel-read-only]")).not.toBeNull();
    expect(query("[data-memory-rebuild-progress]")?.textContent).toBe(language.structuredMemory.rebuild.progress(1, 5));
    press("[data-memory-rebuild-resume]");
    await settle();
    expect(io.runServerJob).toHaveBeenLastCalledWith(
        characterList().find(({ chaId }) => chaId === "c"),
        ref,
        {
            kind: "command",
            command: { type: "memoryRebuild", resume: true },
            label: "memoryRebuild",
            context: { mode: "manual" },
        },
    );
    noteMemoryTaskFrame({
        type: "memoryTask",
        epoch,
        characterId: "c",
        chatId: "k",
        status: { taskId: "rebuild", kind: "structuredMemory", state: "running", done: 3, total: 5 },
    });
    await settle();
    expect(query("[data-memory-rebuild-progress]")?.textContent).toBe(language.structuredMemory.rebuild.progress(3, 5));
    expect(query("[data-memory-rebuild-resume]")).toBeNull();
    press("[data-memory-rebuild-pause]");
    await settle();
    expect(io.authFetch.mock.calls).toContainEqual([
        "/api/memory/tasks/c/k",
        expect.objectContaining({ method: "DELETE" }),
    ]);
    expect(query("[data-memory-rebuild-abandon]")!.closest("button")!.disabled).toBe(false);
    state.rebuild = { mode: "backfill", done: 3, total: 5, resumable: false };
    noteMemoryTaskFrame({
        type: "memoryTask",
        epoch,
        characterId: "c",
        chatId: "k",
        status: {
            taskId: "rebuild",
            kind: "structuredMemory",
            state: "cancelled",
            done: 3,
            total: 5,
            terminalRevision: null,
        },
    });
    await settle();
    click("[data-memory-panel-refresh]");
    await settle();
    expect(query("[data-memory-rebuild-resume]")).toBeNull();
    expect(query("[data-memory-rebuild-pause]")).toBeNull();
    expect(query("[data-memory-rebuild-progress]")?.textContent).toBe(
        language.structuredMemory.rebuild.backfillProgress(3, 5),
    );
    press("[data-memory-rebuild-abandon]");
    await settle();
    expect(alertConfirm).toHaveBeenLastCalledWith(language.structuredMemory.rebuild.abandonConfirm);
    expect(query("[data-memory-rebuild]")).toBeNull();
    expect(query("[data-memory-panel-read-only]")).toBeNull();
});
