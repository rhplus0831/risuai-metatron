import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// The restore notice as the terminal notice (the restore-notice fix after Phase 6 slice 2,
// `persistence.md` Save step 10, `global-api.md` `alertTerminal` and `TerminalNotice.svelte`), in the
// real app against the isolated stack of `playwright.config.ts`. Before the fix a transform the
// restore refused (412 EpochMismatch) toasted over the notice, the toast's end cleared the shared
// alert store, and the page reloaded about a second later without the user's acknowledgement. What
// only the browser shows:
// - a refused transform shows the notice and no toast; ordinary alerts (toast, error, wait, clear)
//   neither hide nor dismiss it, well past the old failure window, and nothing navigates;
// - it is a modal dialog in the top layer: above a full-screen overlay with the largest z-index, with
//   focus on its OK; Escape and a held (repeated) Enter do not acknowledge it;
// - its own OK reloads the page;
// - Enter typed into the composer before it opened goes to the notice's OK, not the composer: no send.
// The server is not restored (no other spec's data changes): the 412 is the transport's real answer
// to a routed request, or the epoch listener the transports call for one.

const NOTICE = "The server data was restored from a backup. The app will reload.";

interface Session {
    page: Page;
    errors: string[];
    navigations: string[];
    generations: string[];
    api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; body: any }>;
}

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const page = await context.newPage();
    const errors: string[] = [];
    const navigations: string[] = [];
    const generations: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    // An unload warning (unsaved work when the page navigates: the seed's reopen, or the reload after
    // a halt) would hold the navigation: accept it. Any other dialog is unexpected.
    page.on("dialog", (dialog) => {
        if (dialog.type() !== "beforeunload") errors.push(`dialog ${dialog.type()}: ${dialog.message()}`);
        void dialog.accept();
    });
    let auth: string | null = null;
    let epoch: string | null = null;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/generations")) {
            generations.push(request.url());
        }
    });
    page.on("response", (response) => {
        const value = response.headers()["x-resource-epoch"];
        if (value) epoch = value;
    });
    await openApp(page, baseURL);
    for (let i = 0; i < 40 && !auth; i++) {
        await page.waitForTimeout(250);
    }
    expect(auth, "the app sent an authenticated request").toBeTruthy();
    const api = async (path: string, init: { method?: string; body?: string } = {}) => {
        const response = await fetch(baseURL + path, {
            ...init,
            headers: { "risu-auth": auth!, "x-resource-epoch": epoch!, "content-type": "application/json" },
        });
        const body = await response.json().catch(() => null);
        if (body?.epoch) epoch = body.epoch;
        return { status: response.status, body };
    };
    return { page, errors, navigations, generations, api };
}

/** Seeds a character with one chat (a greeting and two messages), then reopens the app. */
async function seed(s: Session, baseURL: string): Promise<{ chaId: string; chatId: string }> {
    const ui = (await s.api("/api/resources/ui/main")).body;
    const order = (await s.api("/api/resources/characterOrder/main")).body;
    const chaId = randomUUID();
    const chatId = randomUUID();
    const character = {
        name: `Notice ${chaId.slice(0, 6)}`,
        firstMessage: "Hello greeting",
        desc: "",
        notes: "",
        chatFolders: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        globalLore: [],
        chaId,
        type: "character",
        utilityBot: false,
        customscript: [],
        exampleMessage: "",
        creatorNotes: "",
        systemPrompt: "",
        postHistoryInstructions: "",
        alternateGreetings: [],
        tags: [],
        creator: "",
        characterVersion: "",
        personality: "",
        scenario: "",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [],
    };
    const seeded = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
                { kind: "characters", id: chaId, baseRevision: null, data: character },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), chaId],
                },
            ],
            chats: [
                {
                    characterId: chaId,
                    chatId,
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: chatId,
                                name: "notice chat",
                                message: [
                                    { role: "user", data: "First user message", chatId: "n-user" },
                                    { role: "char", data: "First char reply", chatId: "n-char" },
                                ],
                                scriptstate: {},
                            },
                        },
                    ],
                },
            ],
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    await openApp(s.page, baseURL);
    return { chaId, chatId };
}

async function openChat(page: Page, chaId: string, chatId: string) {
    await page.locator(`[data-char-id="${chaId}"]`).first().click();
    await page.evaluate(
        async ({ chaId, chatId }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            chatStore.selectChat(chaId, chatId);
        },
        { chaId, chatId },
    );
}

/** The terminal notice's state: shown in the top layer, its message, and where the focus is. */
const noticeState = (page: Page) =>
    page.evaluate(async () => {
        const { terminalNotice } = await import("/src/ts/alert.ts");
        const { alertStore } = await import("/src/ts/stores.svelte.ts");
        let message: string | null = null;
        terminalNotice.subscribe((value: string | null) => (message = value))();
        let alert: { type: string; msg: string } = { type: "", msg: "" };
        alertStore.subscribe((value: { type: string; msg: string }) => (alert = value))();
        const dialog = document.querySelector("dialog");
        const active = document.activeElement;
        return {
            message,
            modal: dialog?.matches(":modal") ?? false,
            focusOnOk: !!dialog && !!active && dialog.contains(active) && active.tagName === "BUTTON",
            alertType: alert.type,
            alertMsg: alert.msg,
        };
    });

const notice = (page: Page) => page.getByRole("dialog", { name: NOTICE });

test("a refused transform shows the notice, no toast; nothing but its own OK ends it, and that reloads", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const { chaId, chatId } = await seed(s, baseURL!);
    const { page } = s;
    await page.waitForTimeout(1500);

    // A full-screen overlay with the largest z-index (as `PartialEditController`'s 10000 would be).
    await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.id = "test-cover";
        cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(255,0,0,0.2)";
        document.body.appendChild(cover);
    });
    // The server refuses every transform for another epoch, as after a restore.
    let refused = 0;
    await page.route("**/api/transform**", (route) => {
        refused++;
        return route.fulfill({
            status: 412,
            contentType: "application/json",
            body: JSON.stringify({ error: "EpochMismatch", epoch: "epoch-restored" }),
        });
    });
    const navigationsBefore = s.navigations.length;
    await page.locator(`[data-char-id="${chaId}"]`).first().dispatchEvent("click");
    await page.evaluate(
        async ({ chaId, chatId }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            chatStore.selectChat(chaId, chatId);
        },
        { chaId, chatId },
    );
    await expect(notice(page)).toBeVisible({ timeout: 20_000 });
    expect(refused).toBeGreaterThan(0);
    let state = await noticeState(page);
    expect(state).toMatchObject({ message: NOTICE, modal: true, focusOnOk: true });
    // The refused transform showed no failure toast.
    expect(state.alertType).not.toBe("toast");

    // Ordinary alerts after it: none hides or dismisses it.
    await page.evaluate(async () => {
        const alert = await import("/src/ts/alert.ts");
        alert.alertToast("an ordinary toast");
        await new Promise((resolve) => setTimeout(resolve, 300));
        alert.alertError("an ordinary error");
        await new Promise((resolve) => setTimeout(resolve, 300));
        alert.alertClear();
        alert.alertWait("an unfinished wait");
        await new Promise((resolve) => setTimeout(resolve, 300));
        alert.alertClear();
        alert.alertToast("another toast");
    });
    // Well past the old failure window (the toast's end, about a second).
    await page.waitForTimeout(6000);
    state = await noticeState(page);
    expect(state).toMatchObject({ message: NOTICE, modal: true, focusOnOk: true });
    expect(s.navigations.length).toBe(navigationsBefore);

    // Escape does not acknowledge it, repeated either (a forced close shows it again).
    for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    state = await noticeState(page);
    expect(state).toMatchObject({ message: NOTICE, modal: true, focusOnOk: true });
    expect(s.navigations.length).toBe(navigationsBefore);

    // A held Enter (an auto-repeated keydown, as from a key held since before it opened) does not.
    const cdp = await context.newCDPSession(page);
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r", autoRepeat: true });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    await page.waitForTimeout(1000);
    state = await noticeState(page);
    expect(state).toMatchObject({ message: NOTICE, modal: true });
    expect(s.navigations.length).toBe(navigationsBefore);

    // Its own OK, an ordinary click through the covering overlay (Playwright checks it is the hit
    // target), reloads the page.
    await page.unroute("**/api/transform**");
    await notice(page).getByRole("button", { name: "OK", exact: true }).click();
    await expect.poll(() => s.navigations.length, { timeout: 20_000 }).toBeGreaterThan(navigationsBefore);
    await openApp(page, baseURL!);
    await expect(notice(page)).toHaveCount(0);
    expect(await page.locator("#test-cover").count()).toBe(0);
    expect(s.errors).toEqual([]);
});

test("Enter in the composer once the notice opened goes to its OK: no send, and the page reloads", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const { chaId, chatId } = await seed(s, baseURL!);
    const { page } = s;
    await openChat(page, chaId, chatId);
    await expect(page.locator(".risu-chat").filter({ hasText: "First char reply" }).first()).toBeVisible({
        timeout: 20_000,
    });
    await page.waitForTimeout(1500);
    // Every Enter keydown's target, in the capture phase (before any handler of the page), logged so
    // that the one that acknowledges (and reloads) is recorded too.
    const enterTargets: string[] = [];
    page.on("console", (message) => {
        const text = message.text();
        if (text.startsWith("enter-target ")) enterTargets.push(text.slice("enter-target ".length));
    });
    await page.evaluate(() => {
        window.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Enter") {
                    const target = event.target as HTMLElement;
                    console.log(`enter-target ${target.tagName}:${target.closest("dialog") ? "dialog" : "page"}`);
                }
            },
            true,
        );
    });
    const input = page.locator("textarea.input-text").first();
    await input.click();
    await input.fill("Typed before the restore");
    const navigationsBefore = s.navigations.length;
    // The epoch listener every transport calls for a 412 (the save adapter's halt-and-reload).
    await page.evaluate(async () => {
        const client = await import("/src/ts/storage/resourceClient.ts");
        client.epochMismatch("epoch-restored");
    });
    await expect(notice(page)).toBeVisible({ timeout: 10_000 });
    expect(await noticeState(page)).toMatchObject({ message: NOTICE, modal: true, focusOnOk: true });
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(false);

    await page.keyboard.press("Enter");
    // The Enter went to the notice's OK; the page reloads, and nothing was sent.
    await expect.poll(() => s.navigations.length, { timeout: 20_000 }).toBeGreaterThan(navigationsBefore);
    expect(enterTargets).toEqual(["BUTTON:dialog"]);
    expect(s.generations).toEqual([]);
    await openApp(page, baseURL!);
    await expect(notice(page)).toHaveCount(0);
    expect(s.generations).toEqual([]);
    expect(s.errors).toEqual([]);
});
