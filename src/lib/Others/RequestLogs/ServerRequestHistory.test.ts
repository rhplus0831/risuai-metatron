// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    RequestHistoryPage,
    RequestHistoryRecord,
    RequestHistoryShareBody,
    RequestHistoryShareList,
    RequestHistoryShareResult,
    RequestHistorySummary,
} from "../../../../shared/requestHistory.ts";

// Request history slice 10 (`docs/plan/request-history-diagnostics.md`, "Sharing to the folder"):
// the viewer's share controls. An expanded row's "Share for support" sends the row's job id when
// it has one (so a withdrawal after the row was pruned still names the job) and its request id
// only for a standalone row; the answer's ids mark every listed row ("Shared" badge, "Update
// shared copy" and "Withdraw share"); one operation per target at a time; a failure is a
// localized notice, the server's "older copy could not be removed" answer its own; the "Shared
// copies" box lists the folder's shares with a Withdraw each, keeps the last list when a read
// fails, and shows the error with Retry.

const deps = vi.hoisted(() => ({
    listRequestHistory: vi.fn<() => Promise<RequestHistoryPage>>(),
    readRequestHistory: vi.fn<(id: string) => Promise<RequestHistoryRecord | null>>(),
    shareRequestHistory: vi.fn<(body: RequestHistoryShareBody) => Promise<RequestHistoryShareResult>>(),
    listRequestHistoryShares: vi.fn<() => Promise<RequestHistoryShareList>>(),
    alertError: vi.fn<(text: string) => void>(),
}));
vi.mock("src/ts/network/requestHistory", () => ({
    listRequestHistory: () => deps.listRequestHistory(),
    readRequestHistory: (id: string) => deps.readRequestHistory(id),
    deleteRequestHistory: async () => {},
    shareRequestHistory: (body: RequestHistoryShareBody) => deps.shareRequestHistory(body),
    listRequestHistoryShares: () => deps.listRequestHistoryShares(),
}));
vi.mock("src/ts/alert", () => ({
    alertConfirm: async () => false,
    alertError: (text: string) => deps.alertError(text),
    alertRequestLogs: () => {},
}));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ findCharacter: () => undefined }));
vi.mock("src/ts/storage/chatStore.svelte", () => ({ chatEntry: () => undefined, currentChatRef: () => null }));

import { language } from "src/lang";
import { languageEnglish } from "src/lang/en";
import ServerRequestHistory from "./ServerRequestHistory.svelte";

const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const REQ = (n: number) => `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c${n.toString(16).padStart(2, "0")}`;
const AT = Date.UTC(2026, 9, 15, 12);

function summary(id: string, jobId: string | null, over: Partial<RequestHistorySummary> = {}): RequestHistorySummary {
    return {
        id,
        jobId,
        source: "send",
        mode: "main",
        chaId: null,
        chatId: null,
        messageId: null,
        modelId: "gpt-5",
        profileId: null,
        profileName: null,
        provider: "OpenAI",
        startedAt: AT,
        firstByteAt: null,
        completedAt: AT + 1000,
        status: "success",
        httpStatus: 200,
        providerCode: null,
        hasError: false,
        requestBytes: 10,
        responseBytes: 10,
        content: true,
        exchangeCount: 0,
        storedExchanges: 0,
        truncated: false,
        sharedAt: null,
        bytes: 100,
        ...over,
    };
}
const record = (item: RequestHistorySummary): RequestHistoryRecord => ({
    ...item,
    error: null,
    prompt: null,
    exchanges: [],
    truncation: {},
});
/** Two rows of one job and a standalone one, newest first as the server lists them. */
const ROWS = [summary(REQ(3), null), summary(REQ(2), JOB), summary(REQ(1), JOB)];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
};

let target: HTMLElement;
const mounted: object[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    for (const dep of Object.values(deps)) {
        dep.mockReset();
    }
    deps.listRequestHistory.mockResolvedValue({ items: ROWS, next: null });
    deps.readRequestHistory.mockImplementation(async (id) => {
        const item = ROWS.find((row) => row.id === id);
        return item ? record(item) : null;
    });
    deps.listRequestHistoryShares.mockResolvedValue({ items: [] });
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    target.remove();
    vi.useRealTimers();
});

async function open() {
    mounted.push(mount(ServerRequestHistory, { target, props: { jobId: null } }));
    await settle();
    const buttons = () => [...target.querySelectorAll("button")];
    const button = (label: string, within: Element = target) =>
        [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null;
    /** The row's outer box, found by its (shortened) request id in the expanded meta. */
    const rowBox = (id: string) => {
        const boxes = [...target.querySelectorAll(":scope > div.flex.flex-col > div")];
        return boxes[ROWS.findIndex((row) => row.id === id)];
    };
    const expand = async (id: string) => {
        (rowBox(id).querySelector("button") as HTMLButtonElement).click();
        await settle();
    };
    const badges = () => buttons().filter((b) => b.textContent?.includes(language.requestHistoryShared)).length;
    return { button, rowBox, expand, badges, text: () => target.textContent ?? "" };
}

describe("ServerRequestHistory: sharing for support", () => {
    it("shares a row's job by job id, marks every row the answer names, and offers Update and Withdraw (by job id) on them; a standalone row goes by request id", async () => {
        const view = await open();
        expect(deps.listRequestHistoryShares).toHaveBeenCalledTimes(1);
        expect(view.badges()).toBe(0);
        await view.expand(REQ(1));
        const box = view.rowBox(REQ(1));
        expect(view.button(language.requestHistoryShare, box)).not.toBeNull();
        expect(view.button(language.requestHistoryShareWithdraw, box)).toBeNull();
        expect(box.textContent).toContain(language.requestHistoryShareHelp);
        const pending = deferred<RequestHistoryShareResult>();
        deps.shareRequestHistory.mockReturnValueOnce(pending.promise);
        view.button(language.requestHistoryShare, box)!.click();
        flushSync();
        expect(deps.shareRequestHistory).toHaveBeenCalledWith({ jobId: JOB, shared: true });
        expect(view.button(language.requestHistoryShare, box)!.disabled).toBe(true);
        // The same target from another row of the job is held too.
        await view.expand(REQ(2));
        expect(view.button(language.requestHistoryShare, view.rowBox(REQ(2)))!.disabled).toBe(true);
        view.button(language.requestHistoryShare, view.rowBox(REQ(2)))!.click();
        expect(deps.shareRequestHistory).toHaveBeenCalledTimes(1);
        pending.resolve({ jobId: JOB, requestId: null, shared: true, sharedAt: AT + 5000, ids: [REQ(1), REQ(2)] });
        await settle();
        expect(view.badges()).toBe(2);
        for (const id of [REQ(1), REQ(2)]) {
            const row = view.rowBox(id);
            expect(row.textContent).toContain(
                language.requestHistorySharedAt.replace("{{time}}", new Date(AT + 5000).toLocaleString()),
            );
            expect(view.button(language.requestHistoryShareUpdate, row)!.disabled).toBe(false);
            expect(view.button(language.requestHistoryShareWithdraw, row)!.disabled).toBe(false);
            expect(view.button(language.requestHistoryShare, row)).toBeNull();
        }
        expect(deps.listRequestHistoryShares).toHaveBeenCalledTimes(2);
        deps.shareRequestHistory.mockResolvedValueOnce({
            jobId: JOB,
            requestId: null,
            shared: true,
            sharedAt: AT + 6000,
            ids: [REQ(1), REQ(2)],
        });
        view.button(language.requestHistoryShareUpdate, view.rowBox(REQ(2)))!.click();
        await settle();
        expect(deps.shareRequestHistory).toHaveBeenLastCalledWith({ jobId: JOB, shared: true });
        deps.shareRequestHistory.mockResolvedValueOnce({
            jobId: JOB,
            requestId: null,
            shared: false,
            sharedAt: null,
            ids: [REQ(1), REQ(2)],
        });
        view.button(language.requestHistoryShareWithdraw, view.rowBox(REQ(1)))!.click();
        await settle();
        expect(deps.shareRequestHistory).toHaveBeenLastCalledWith({ jobId: JOB, shared: false });
        expect(view.badges()).toBe(0);
        expect(view.button(language.requestHistoryShare, view.rowBox(REQ(1)))).not.toBeNull();

        await view.expand(REQ(3));
        deps.shareRequestHistory.mockResolvedValueOnce({
            jobId: null,
            requestId: REQ(3),
            shared: true,
            sharedAt: AT,
            ids: [REQ(3)],
        });
        view.button(language.requestHistoryShare, view.rowBox(REQ(3)))!.click();
        await settle();
        expect(deps.shareRequestHistory).toHaveBeenLastCalledWith({ requestId: REQ(3), shared: true });
        expect(view.badges()).toBe(1);
        expect(deps.alertError).not.toHaveBeenCalled();
    });

    it("shows a failed share as a localized notice (the server's older-copy answer as its own), leaving the marks as they were", async () => {
        const view = await open();
        await view.expand(REQ(1));
        deps.shareRequestHistory.mockRejectedValueOnce(new Error("The shared copy could not be written"));
        view.button(language.requestHistoryShare, view.rowBox(REQ(1)))!.click();
        await settle();
        expect(deps.alertError).toHaveBeenLastCalledWith(
            language.requestHistoryShareFailed.replace("{{error}}", "The shared copy could not be written"),
        );
        expect(view.badges()).toBe(0);
        expect(view.button(language.requestHistoryShare, view.rowBox(REQ(1)))!.disabled).toBe(false);
        deps.shareRequestHistory.mockRejectedValueOnce(new Error(languageEnglish.requestHistoryShareOlderCopiesRemain));
        view.button(language.requestHistoryShare, view.rowBox(REQ(1)))!.click();
        await settle();
        expect(deps.alertError).toHaveBeenLastCalledWith(language.requestHistoryShareOlderCopiesRemain);
    });

    it("lists the folder's shared copies with a Withdraw each (by job id or request id), keeps the last list when a read fails, and shows the error with Retry", async () => {
        const entries = [
            { jobId: JOB, requestId: null, sharedAt: AT + 100 },
            { jobId: null, requestId: REQ(9), sharedAt: AT },
        ];
        deps.listRequestHistoryShares.mockResolvedValue({ items: entries });
        const view = await open();
        expect(view.text()).toContain(language.requestHistoryShares);
        const box = target.querySelector(":scope > div.border.rounded-lg.mb-3")!;
        const compact = () => box.textContent!.replace(/\s+/g, " ");
        expect(compact()).toContain(`${language.requestHistorySameJob}: ${JOB.slice(0, 8)}`);
        expect(compact()).toContain(`${language.requestHistoryLabels.request}: ${REQ(9).slice(0, 8)}`);
        const withdraws = [...box.querySelectorAll("button")].filter(
            (b) => b.textContent?.trim() === language.requestHistoryShareWithdraw,
        );
        expect(withdraws).toHaveLength(2);
        deps.shareRequestHistory.mockResolvedValueOnce({
            jobId: null,
            requestId: REQ(9),
            shared: false,
            sharedAt: null,
            ids: [],
        });
        // The next list read fails: the entries stay, the error shows with Retry.
        deps.listRequestHistoryShares.mockRejectedValueOnce(new Error("offline"));
        withdraws[1].click();
        await settle();
        expect(deps.shareRequestHistory).toHaveBeenLastCalledWith({ requestId: REQ(9), shared: false });
        expect(box.textContent).toContain(language.requestHistorySharesLoadFailed.replace("{{error}}", "offline"));
        expect(compact()).toContain(`${language.requestHistoryLabels.request}: ${REQ(9).slice(0, 8)}`);
        deps.listRequestHistoryShares.mockResolvedValueOnce({ items: [entries[0]] });
        view.button(language.requestHistoryRetry, box)!.click();
        await settle();
        expect(box.textContent).not.toContain(language.requestHistorySharesLoadFailed.replace("{{error}}", "offline"));
        expect(box.textContent).not.toContain(REQ(9).slice(0, 8));
        deps.shareRequestHistory.mockResolvedValueOnce({
            jobId: JOB,
            requestId: null,
            shared: false,
            sharedAt: null,
            ids: [REQ(1), REQ(2)],
        });
        deps.listRequestHistoryShares.mockResolvedValueOnce({ items: [] });
        view.button(language.requestHistoryShareWithdraw, box)!.click();
        await settle();
        expect(deps.shareRequestHistory).toHaveBeenLastCalledWith({ jobId: JOB, shared: false });
        // No shares and no error: the box is gone.
        expect(view.text()).not.toContain(language.requestHistoryShares);
    });
});
