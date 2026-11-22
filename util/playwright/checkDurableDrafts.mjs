// Drive durable drafts through real browser loss on one dev stack and one persistent profile.
// Each mutation is cut before its batch reaches the server, after route.fetch commits but its
// answer is withheld, or while the journal's readwrite transaction is kept alive and uncommitted
// (the batch is also withheld). SIGKILL targets Chrome's browser process, so no hide/unload handler
// can save the case. Relaunches retain the origin, server data, IndexedDB, and browser profile.
// Checks include server readback, original chat replay identities, repeated recovery, other-epoch
// JSON export after an archive restore, composer restoration, graceful close, and observed bfcache
// eligibility. Uncommitted-journal loss and pagehide-only loss are asserted as documented limits.
// A chat's trash is a route call outside the save queue and the journal: cut before or after its
// commit, the relaunched tab shows the server's mark and nothing replays it.
// This uses dev modules for mutations; the composer and recovery export are driven through the UI.
//
// Usage: node util/playwright/checkDurableDrafts.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import {
    startStack,
    openApp,
    openCharacterChat,
    clearSafeBootAttempts,
    chromePath,
    isolateContext,
    unexpectedEgress,
} from "./stack.mjs";
import { chatBindingFixture } from "./modelProfiles.mjs";

const execFileAsync = promisify(execFile);
const profile = path.join(os.tmpdir(), `risu-durable-drafts-${process.pid}`);
const results = [];
const blocked = [];
const cuts = ["before-commit", "answer-dropped", "journal-held"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stack;
let context;
let page;
let auth;
let epoch;
let gate;
let traffic = [];
let transports = [];
let binding;
let serial = 0;
const lifecycle = [];

function check(name, ok, evidence) {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(evidence)}`);
}
async function until(fn, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await fn();
            if (last) return last;
        } catch (error) {
            last = String(error);
        }
        await sleep(100);
    }
    throw new Error(`${label}: timed out; last=${JSON.stringify(last)}`);
}
async function api(url, body, contentType = "application/json") {
    const response = await fetch(`${stack.serverURL}${url}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": contentType },
        ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
    assert(response.ok, `${url}: ${response.status} ${await response.clone().text()}`);
    if (url === "/api/backups/export") return Buffer.from(await response.arrayBuffer());
    const result = await response.json();
    if (result.epoch) epoch = result.epoch;
    return result;
}
async function ready() {
    await until(
        () =>
            page.evaluate(async () => {
                const { loadedStore } = await import("/src/ts/stores.svelte.ts");
                let loaded;
                loadedStore.subscribe((value) => (loaded = value))();
                return loaded;
            }),
        "loadedStore in current document",
        120_000,
    );
}

// A real transaction, not a fake journal success: an endless request chain prevents auto-commit.
// The driver enables this only after baseline boot/acknowledgement transactions have settled.
function instrumentJournal() {
    window.__durableHold = false;
    window.__durableHeld = 0;
    window.__durableAttempts = [];
    let lastLifecycleEvent = null;
    const fetch = window.fetch;
    window.fetch = function (input, init) {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
        if (url.pathname === "/api/resources/batch") {
            // Observe the native request flag without changing the request or awaiting a binding
            // during pagehide. Both transports use the same endpoint and authentication headers.
            void window.__durableTransport?.({
                url: url.href,
                keepalive: init?.keepalive ?? (input instanceof Request ? input.keepalive : false),
                body: typeof init?.body === "string" ? init.body : null,
                visibility: document.visibilityState,
                lifecycleEvent: lastLifecycleEvent,
            });
        }
        return fetch.call(this, input, init);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name === "risu-draft-journal" && args[1] === "readwrite" && window.__durableHold) {
            window.__durableHeld++;
            const store = tx.objectStore(tx.objectStoreNames[0]);
            const keepAlive = () => {
                if (!window.__durableHold) return;
                const request = store.get("__durable_keepalive__");
                request.onsuccess = keepAlive;
            };
            keepAlive();
        }
        return tx;
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
        if (this.transaction.db.name === "risu-draft-journal" && window.__durableHold) {
            window.__durableAttempts.push(structuredClone(value));
        }
        return put.call(this, value, ...args);
    };
    for (const name of ["pagehide", "beforeunload", "pageshow", "visibilitychange"]) {
        addEventListener(name, (event) => {
            lastLifecycleEvent = name;
            void window.__durableLifecycle?.({ name, persisted: event.persisted ?? null, hidden: document.hidden });
        });
    }
}
async function launch() {
    gate = null;
    traffic = [];
    transports = [];
    context = await chromium.launchPersistentContext(profile, {
        executablePath: chromePath,
        headless: true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        // Playwright disables bfcache by default; let Chrome decide eligibility for this app.
        ignoreDefaultArgs: ["--disable-back-forward-cache"],
        args: ["--no-default-browser-check"],
    });
    context.setDefaultTimeout(20_000);
    blocked.push(await isolateContext(context));
    await clearSafeBootAttempts(context);
    await context.exposeBinding("__durableLifecycle", (_, event) => lifecycle.push(event));
    await context.exposeBinding("__durableTransport", (_, event) => transports.push(event));
    await context.addInitScript(instrumentJournal);
    const entriesByRequest = new WeakMap();
    context.on("response", async (response) => {
        const entry = entriesByRequest.get(response.request());
        if (!entry) return;
        try {
            entry.status = response.status();
            entry.answer = await response.json();
            entry.committed = response.ok();
        } catch (error) {
            entry.responseError = String(error);
        }
    });
    // Install the routes before the first navigation, including any boot recovery dispatch.
    const cutRoute = async (route) => {
        const body = route.request().postDataJSON();
        const entry = { url: route.request().url(), body, committed: false };
        entriesByRequest.set(route.request(), entry);
        traffic.push(entry);
        const active = gate;
        if (!active) return route.continue();
        active.requests.push(entry);
        if (active.cut === "answer-dropped") {
            try {
                const response = await route.fetch({ timeout: 20_000, maxRetries: 0 });
                entry.status = response.status();
                entry.answer = await response.json();
                entry.committed = response.ok();
            } catch (error) {
                entry.error = String(error);
            }
        }
        // Deliberately neither fulfil nor abort: the page has no answer until it is killed.
    };
    await context.route("**/api/resources/batch", cutRoute);
    await context.route("**/api/chat-trash/*", cutRoute);
    page = context.pages()[0] ?? (await context.newPage());
    page.on("dialog", (dialog) => dialog.accept());
    context.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
    });
    await openApp(page, stack.baseURL);
}
async function kill() {
    // Exact argument match excludes renderer/utility processes that also carry the profile path.
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
    const candidates = stdout
        .split("\n")
        .filter((line) => line.includes(`--user-data-dir=${profile}`) && !line.includes("--type="));
    assert.equal(candidates.length, 1, `Chrome browser pid: ${JSON.stringify(candidates)}`);
    const pid = Number(candidates[0].trim().split(/\s+/)[0]);
    const closed = context.waitForEvent("close");
    process.kill(pid, "SIGKILL");
    await closed;
    context = null;
}
async function rows() {
    return page.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const request = indexedDB.open("risu-draft-journal");
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction("entries", "readonly");
                    const read = tx.objectStore("entries").getAll();
                    tx.oncomplete = () => {
                        db.close();
                        resolve(read.result);
                    };
                    tx.onerror = () => reject(tx.error);
                };
            }),
    );
}
const rowFor = (row, fixture, kind) =>
    kind === "settings"
        ? row.scope === "record" && row.target === "ui\0main"
        : kind === "composer"
          ? row.type === "composer" && row.chatKey === `${fixture.chaId}\0${fixture.chatId}`
          : row.target?.includes(fixture.chaId);
const briefRows = (list) =>
    list.map(({ type, scope, target, id, chatKey, otherEpoch, layers, value, epoch: rowEpoch }) => ({
        type,
        scope,
        target,
        id,
        chatKey,
        otherEpoch,
        layers,
        value,
        epoch: rowEpoch,
    }));
async function readState(fixture) {
    const answer = await api("/api/resources/read", {
        refs: [
            { kind: "characters", id: fixture.chaId },
            { kind: "ui", id: "main" },
        ],
        chatCollections: [fixture.chaId],
    });
    const collection = answer.chatCollections[0];
    return {
        character: answer.items.find((record) => record.kind === "characters")?.data,
        characterRevision: answer.items.find((record) => record.kind === "characters")?.revision,
        ui: answer.items.find((record) => record.kind === "ui").data,
        uiRevision: answer.items.find((record) => record.kind === "ui").revision,
        order: collection.order?.ids,
        orderRevision: collection.order?.revision,
        chats: collection.chats,
    };
}
async function seed() {
    gate = null;
    await page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources());
    const fixture = {
        chaId: randomUUID(),
        chatId: randomUUID(),
        secondId: randomUUID(),
        thirdId: randomUUID(),
        newChatId: randomUUID(),
        messageId: randomUUID(),
        marker: `Durable ${++serial}`,
        zoom: 95 + (serial % 10),
    };
    const characterOrder = await api("/api/resources/characterOrder/main");
    await api("/api/resources/batch", {
        ops: [
            {
                kind: "characterOrder",
                id: "main",
                baseRevision: characterOrder.revision,
                data: [...characterOrder.data, fixture.chaId],
            },
            {
                kind: "characters",
                id: fixture.chaId,
                baseRevision: null,
                data: {
                    chaId: fixture.chaId,
                    type: "character",
                    name: fixture.marker,
                    desc: "Original description",
                    firstMessage: "Hello",
                    globalLore: [],
                    customscript: [],
                    additionalAssets: [],
                    emotionImages: [],
                    bias: [],
                    viewScreen: "none",
                    chatFolders: [],
                    firstMsgIndex: -1,
                },
            },
        ],
        chats: [fixture.chatId, fixture.secondId, fixture.thirdId].map((chatId, i) => ({
            characterId: fixture.chaId,
            chatId,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: {
                        id: chatId,
                        name: `Chat ${i + 1}`,
                        note: "",
                        localLore: [],
                        ...binding,
                        message: i === 0 ? [{ role: "user", data: "Original message", chatId: fixture.messageId }] : [],
                    },
                },
            ],
        })),
    });
    await page.reload();
    await ready();
    // Warm the modules before cutting a request: dependency optimization may replace the document.
    await until(
        () =>
            page.evaluate(async () => {
                await Promise.all([
                    import("/src/ts/storage/settingsViews.svelte.ts"),
                    import("/src/ts/storage/characterStore.svelte.ts"),
                    import("/src/ts/storage/chatStore.svelte.ts"),
                ]);
                return true;
            }),
        "warm mutation modules",
    );
    await page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources());
    assert(
        await page.evaluate(async () => (await import("/src/ts/storage/draftJournal.ts")).pageDraftJournal().enabled),
        "page journal enabled before cutting work",
    );
    fixture.baseline = await readState(fixture);
    return fixture;
}
async function openComposer(fixture) {
    await openCharacterChat(page, fixture.chaId);
    const input = page.locator("textarea.input-text").first();
    await input.waitFor();
    return input;
}
async function mutate(kind, fixture) {
    if (kind === "composer") {
        await (await openComposer(fixture)).fill(fixture.marker);
        // Composer rows never enter the resource batch. A settings companion gives both transport
        // cuts a real request while checking that no chat send starts from restored input.
        await page.evaluate(async (zoom) => {
            (await import("/src/ts/storage/settingsViews.svelte.ts")).settings.ui.zoomsize = zoom;
        }, fixture.zoom);
        return;
    }
    await page.evaluate(
        async ({ kind, f }) => {
            const chats = await import("/src/ts/storage/chatStore.svelte.ts");
            const ref = { chaId: f.chaId, chatId: f.chatId };
            if (kind === "settings")
                (await import("/src/ts/storage/settingsViews.svelte.ts")).settings.ui.zoomsize = f.zoom;
            if (kind === "character" || kind === "restore" || kind === "moved-base")
                (await import("/src/ts/storage/characterStore.svelte.ts")).updateCharacter(f.chaId, { desc: f.marker });
            if (kind === "message" || kind === "recovery-again") {
                await chats.ensureChatLoaded(ref);
                chats.setMessageText(ref, f.messageId, f.marker);
            }
            if (kind === "reorder") chats.reorderChats(f.chaId, [f.thirdId, f.chatId, f.secondId]);
            if (kind === "chat-create")
                chats.createChat(f.chaId, { id: f.newChatId, name: f.marker, message: [], localLore: [], note: "" });
        },
        { kind, f: fixture },
    );
}
async function cutWork(kind, cut, fixture) {
    gate = { cut, requests: [] };
    const persisted = (await rows()).filter((row) => rowFor(row, fixture, kind));
    if (cut === "journal-held")
        await page.evaluate(() => {
            window.__durableHold = true;
        });
    await mutate(kind, fixture);
    await until(
        () => gate.requests.some((request) => cut !== "answer-dropped" || request.committed),
        "batch cut reached",
    );
    if (cut === "answer-dropped") assert(gate.requests.every((request) => request.status === 200));
    let journal;
    if (cut === "journal-held") {
        await until(
            () => page.evaluate(() => window.__durableHeld > 0),
            "held journal transaction (later writes may queue behind a composer purge)",
        );
        journal = {
            committedBeforeHold: briefRows(persisted),
            ...(await page.evaluate(() => ({
                heldTransactions: window.__durableHeld,
                uncommittedAttempts: window.__durableAttempts,
            }))),
        };
    } else {
        journal = await until(async () => {
            const list = (await rows()).filter((row) => rowFor(row, fixture, kind));
            return (
                list.some((row) =>
                    JSON.stringify(row).includes(
                        kind === "settings"
                            ? String(fixture.zoom)
                            : kind === "reorder"
                              ? fixture.thirdId
                              : fixture.marker,
                    ),
                ) && list
            );
        }, "committed journal row");
        journal = briefRows(journal);
    }
    return { requests: structuredClone(gate.requests), journal, server: await readState(fixture) };
}
function outcome(kind, fixture, state, changed, remote) {
    const chat = state.chats.find((row) => row.id === fixture.chatId)?.data;
    assert.equal(new Set(state.chats.map((row) => row.id)).size, state.chats.length, "no duplicate chat");
    assert.equal(
        state.chats.length,
        kind === "chat-create" && changed ? 4 : 3,
        "exact chat membership, with no additional create or delete",
    );
    assert.equal(
        new Set(chat.message.map((message) => message.chatId)).size,
        chat.message.length,
        "no duplicate message",
    );
    assert.equal(chat.message.length, 1, "no additional message");
    if (kind === "settings" || kind === "composer")
        assert.equal(state.ui.zoomsize, changed ? fixture.zoom : fixture.baseline.ui.zoomsize);
    if (kind === "character")
        assert.equal(state.character.desc, changed ? fixture.marker : fixture.baseline.character.desc);
    if (kind === "message" || kind === "recovery-again")
        assert.equal(chat.message[0].data, remote?.value ?? (changed ? fixture.marker : "Original message"));
    if (kind === "reorder")
        assert.deepEqual(
            state.order,
            changed ? [fixture.thirdId, fixture.chatId, fixture.secondId] : fixture.baseline.order,
        );
    if (kind === "chat-create")
        assert.equal(state.chats.filter((row) => row.id === fixture.newChatId).length, changed ? 1 : 0);
    return {
        desc: state.character.desc,
        zoom: state.ui.zoomsize,
        text: chat.message[0].data,
        order: state.order,
        chatCount: state.chats.length,
        characterRevision: state.characterRevision,
        uiRevision: state.uiRevision,
        orderRevision: state.orderRevision,
        chatRevisions: Object.fromEntries(state.chats.map((row) => [row.id, row.revision])),
    };
}
async function flush() {
    await page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources());
}
async function verifyReplay(fixture, original, remembered = false) {
    const group = original.requests.flatMap((request) => request.body.chats ?? [])[0];
    if (!group) return undefined;
    const request = traffic.find((entry) => entry.body.chats?.some((candidate) => candidate.chatId === group.chatId));
    const replay = request?.body.chats.find((candidate) => candidate.chatId === group.chatId);
    assert(replay, "chat recovery dispatched its group");
    assert.equal(replay.groupId, group.groupId, "original groupId");
    assert.equal(replay.retry, true, "retry flag");
    assert.equal(replay.baseRevision, group.baseRevision, "original base revision");
    assert.deepEqual(replay.ops, group.ops, "original operations");
    let earlierResult;
    let replayResult;
    if (remembered) {
        earlierResult = original.requests
            .flatMap((entry) => entry.answer?.chats ?? [])
            .find((row) => row.id === group.chatId);
        assert(earlierResult, "withheld committed result captured");
        replayResult = await until(
            () => request.answer?.chats?.find((row) => row.id === group.chatId),
            "remembered replay response captured",
        );
        assert.equal(request.status, 200, "remembered replay succeeds");
        assert.deepEqual(
            replayResult,
            earlierResult,
            "replay returns the earlier result, not a new execution's revision",
        );
    }
    return {
        originalGroupId: group.groupId,
        replayGroupId: replay.groupId,
        retry: replay.retry,
        baseRevision: replay.baseRevision,
        earlierResult,
        replayResult,
    };
}

/** Challenge a landed group after its browser is killed, so the old page cannot absorb the remote edit. */
async function editAfterCommit(kind, fixture, original) {
    const group = original.requests.flatMap((request) => request.body.chats ?? [])[0];
    const answer = original.requests.find((entry) =>
        entry.answer?.chats?.some((row) => row.id === group.chatId),
    ).answer;
    const originalResult = answer.chats.find((row) => row.id === group.chatId);
    const chatId = group.chatId;
    const current = original.server.chats.find((row) => row.id === chatId);
    assert(current, "remote-edit target exists after first commit");
    assert.equal(current.revision, originalResult.revision, "first server read holds the committed revision");
    const field = kind === "chat-create" ? "name" : "text";
    const value = `${fixture.marker} / remote after commit`;
    const ops =
        field === "name"
            ? [{ op: "meta", set: { name: value } }]
            : [{ op: "setText", id: fixture.messageId, text: value }];
    const remoteGroup = {
        characterId: fixture.chaId,
        chatId,
        baseRevision: current.revision,
        groupId: randomUUID(),
        ops,
    };
    const remoteAnswer = await api("/api/resources/batch", { chats: [remoteGroup] });
    const remoteResult = remoteAnswer.chats.find((row) => row.id === chatId);
    assert(remoteResult && remoteResult.revision !== current.revision, "the remote edit advances the target revision");
    const remote = {
        chatId,
        field,
        value,
        originalResult,
        remoteGroup,
        remoteResult,
        orderRevision: original.server.orderRevision,
    };
    verifyRemoteEdit(fixture, remote, await readState(fixture));
    return remote;
}

function verifyRemoteEdit(fixture, remote, state) {
    const current = state.chats.find((row) => row.id === remote.chatId);
    assert(current, "remote-edited chat survives recovery");
    assert.equal(
        current.revision,
        remote.remoteResult.revision,
        "recovery adds no execution after the one remote edit",
    );
    assert.equal(
        remote.field === "name"
            ? current.data.name
            : current.data.message.find((row) => row.chatId === fixture.messageId)?.data,
        remote.value,
        "remote edit survives the original group's replay",
    );
    assert.equal(state.orderRevision, remote.orderRevision, "recovery neither recreates nor deletes a chat again");
    return {
        chatId: current.id,
        remoteRevision: remote.remoteResult.revision,
        recoveredRevision: current.revision,
        value: remote.value,
        committedOrderRevision: remote.orderRevision,
        recoveredOrderRevision: state.orderRevision,
    };
}
async function runMutation(kind, cut) {
    const fixture = await seed();
    const before = await cutWork(kind, cut, fixture);
    const serverChanged = cut === "answer-dropped";
    outcome(kind, fixture, before.server, serverChanged);
    await kill();
    const remote =
        serverChanged && ["message", "chat-create"].includes(kind)
            ? await editAfterCommit(kind, fixture, before)
            : undefined;
    await launch();
    await flush();
    const expectedChange = cut !== "journal-held" && !(kind === "chat-create" && cut === "before-commit");
    const recovered = await readState(fixture);
    const server = outcome(kind, fixture, recovered, expectedChange, remote);
    const dedupe = remote ? verifyRemoteEdit(fixture, remote, recovered) : undefined;
    let composer;
    let replay;
    if (kind === "composer") {
        const input = await openComposer(fixture);
        await until(
            async () => (await input.inputValue()) === (expectedChange ? fixture.marker : ""),
            "composer restored",
        );
        composer = await input.inputValue();
        assert.equal(
            traffic
                .flatMap((request) => request.body.chats ?? [])
                .filter((group) => group.characterId === fixture.chaId).length,
            0,
            "composer never starts a send",
        );
    } else if (expectedChange && ["message", "chat-create"].includes(kind)) {
        replay = await verifyReplay(fixture, before, cut === "answer-dropped");
    }
    let remaining = (await rows()).filter((row) => rowFor(row, fixture, kind));
    if (kind === "chat-create" && cut === "before-commit") {
        assert(
            remaining.some((row) => row.type === "draft" && row.target.includes(fixture.newChatId)),
            "dispatched absent create is a recovery draft",
        );
    } else if (kind !== "composer") {
        await until(
            async () => !(await rows()).some((row) => row.type === "mutation" && rowFor(row, fixture, kind)),
            "acknowledged journal removed",
        );
        remaining = (await rows()).filter((row) => rowFor(row, fixture, kind));
    }
    if (cut === "answer-dropped" && ["settings", "character"].includes(kind)) {
        const writes = traffic.flatMap((request) => request.body.ops ?? []);
        assert(
            !writes.some((op) => (kind === "settings" ? op.kind === "ui" : op.id === fixture.chaId)),
            "landed record recognized without another write",
        );
        const resourceKind = kind === "settings" ? "ui" : "characters";
        const committed = before.requests
            .flatMap((entry) => entry.answer?.results ?? [])
            .find((row) => row.kind === resourceKind);
        assert(committed, "withheld committed record revision captured");
        const revision = kind === "settings" ? recovered.uiRevision : recovered.characterRevision;
        assert.equal(revision, committed.revision, "recognized record does not advance past the committed revision");
    }
    check(`${kind} / ${cut}${cut === "journal-held" ? " / documented uncommitted loss" : ""}`, true, {
        cut: {
            requests: before.requests,
            journal: before.journal,
            server: outcome(kind, fixture, before.server, serverChanged),
        },
        recovered: server,
        ...(kind === "composer"
            ? { transport: "browser-local composer with a settings companion at the batch cut; no automatic chat send" }
            : {}),
        composer,
        replay,
        remoteAfterCommit: remote,
        dedupe,
        remaining: briefRows(remaining),
    });
}
/**
 * Trashes the third chat through the trash route and cuts that request (before it reaches the
 * server, or after it commits with its answer withheld), then kills the browser. A trash is not
 * journaled and not replayed: after the relaunch the tab shows what the server holds, the chat a
 * member either way, outside the active list only when the trash committed.
 */
async function runTrash(cut) {
    const fixture = await seed();
    const ref = { chaId: fixture.chaId, chatId: fixture.thirdId };
    gate = { cut, requests: [] };
    // The token is captured before the request; the call stays pending while the cut holds its answer.
    await page.evaluate(async (ref) => {
        const chats = await import("/src/ts/storage/chatStore.svelte.ts");
        const { trashChat } = await import("/src/ts/checkpoints/chatTrash.ts");
        void trashChat(ref, chats.chatTrashRevision(ref));
    }, ref);
    await until(
        () =>
            gate.requests.some(
                (request) =>
                    new URL(request.url).pathname === "/api/chat-trash/trash" &&
                    (cut !== "answer-dropped" || request.committed),
            ),
        "trash request cut reached",
    );
    const committed = cut === "answer-dropped";
    const markOf = (state) => state.chats.find((row) => row.id === fixture.thirdId)?.trashedAt;
    const before = await readState(fixture);
    assert.equal(before.chats.length, 3, "a trash removes no chat");
    assert.equal(typeof markOf(before) === "number", committed, "the server holds the mark only once committed");
    assert.equal(
        gate.requests.filter((request) => new URL(request.url).pathname === "/api/resources/batch").length,
        0,
        "a trash sends no batch",
    );
    const journal = briefRows((await rows()).filter((row) => rowFor(row, fixture, "trash")));
    assert.deepEqual(journal, [], "a trash writes no journal row");
    const requests = structuredClone(gate.requests);
    await kill();
    await launch();
    await flush();
    const recovered = await readState(fixture);
    assert.equal(recovered.chats.length, 3, "recovery removes no chat");
    assert.equal(markOf(recovered), markOf(before) ?? null, "recovery leaves the mark as the server held it");
    const view = await until(
        () =>
            page.evaluate(async (ref) => {
                const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                const members = chats.chatList(ref.chaId).map((entry) => entry.id);
                if (!members.includes(ref.chatId)) return null;
                return {
                    members,
                    active: chats.activeChatList(ref.chaId).map((entry) => entry.id),
                    trashed: chats.trashedChatList(ref.chaId).map((entry) => entry.id),
                };
            }, ref),
        "relaunched chat list",
    );
    assert.equal(view.members.length, 3, "the trashed chat stays a member");
    assert.equal(view.active.includes(fixture.thirdId), !committed, "a committed trash leaves the active list");
    assert.equal(view.trashed.includes(fixture.thirdId), committed, "a committed trash lists in the trash");
    assert.equal(
        traffic.filter((request) => new URL(request.url).pathname.startsWith("/api/chat-trash/")).length,
        0,
        "nothing resends the trash",
    );
    assert(
        !traffic.some((request) =>
            (request.body?.chats ?? []).some((group) => group.ops.some((op) => op.op === "delete")),
        ),
        "no delete op is sent",
    );
    assert.deepEqual(briefRows((await rows()).filter((row) => rowFor(row, fixture, "trash"))), [], "no journal row");
    check(`trash / ${cut}`, true, {
        cut: { requests, mark: markOf(before) ?? null },
        recovered: { mark: markOf(recovered) ?? null, view },
    });
}
async function runRecoveryAgain(cut) {
    const fixture = await seed();
    const first = await cutWork("recovery-again", cut, fixture);
    await kill();
    const remote = cut === "answer-dropped" ? await editAfterCommit("recovery-again", fixture, first) : undefined;
    // Gate before navigation: kill a boot recovery before its acknowledgement, then recover again.
    const launchPromise = launch();
    // launch sets gate before its first await; this assignment also catches the first boot batch.
    gate = { cut: cut === "answer-dropped" ? "answer-dropped" : "before-commit", requests: [] };
    await launchPromise;
    let middle;
    if (cut !== "journal-held") {
        await until(
            () => gate.requests.some((entry) => cut !== "answer-dropped" || entry.committed),
            "first recovery dispatch",
        );
        const replay = await verifyReplay(fixture, first, cut === "answer-dropped");
        middle = {
            requests: structuredClone(gate.requests),
            journal: briefRows((await rows()).filter((row) => rowFor(row, fixture, "message"))),
            replay,
            dedupe: remote ? verifyRemoteEdit(fixture, remote, await readState(fixture)) : undefined,
        };
    } else {
        await flush();
        middle = {
            requests: gate.requests,
            journal: briefRows((await rows()).filter((row) => rowFor(row, fixture, "message"))),
        };
        assert.equal(gate.requests.length, 0, "no uncommitted work to recover");
    }
    await kill();
    await launch();
    await flush();
    const recovered = await readState(fixture);
    const server = outcome("message", fixture, recovered, cut !== "journal-held", remote);
    const replay = cut === "journal-held" ? undefined : await verifyReplay(fixture, first, cut === "answer-dropped");
    await until(
        async () => !(await rows()).some((row) => row.type === "mutation" && rowFor(row, fixture, "message")),
        "second recovery journal cleanup",
    );
    check(`recovery-again / ${cut}${cut === "journal-held" ? " / documented uncommitted loss" : ""}`, true, {
        first,
        middle,
        server,
        replay,
        remoteAfterCommit: remote,
        dedupe: remote ? verifyRemoteEdit(fixture, remote, recovered) : undefined,
    });
}
async function runRestore(cut) {
    const fixture = await seed();
    const archive = await api("/api/backups/export", {});
    const oldEpoch = epoch;
    const before = await cutWork("restore", cut, fixture);
    const restored = await api("/api/backups/import", archive, "application/octet-stream");
    assert.notEqual(restored.epoch, oldEpoch, "restore changes epoch");
    await page.getByText("restored from a backup", { exact: false }).waitFor();
    // The halt's snapshot has a 1 s bound. With an intentionally held transaction it cannot commit.
    if (cut === "journal-held") await sleep(1200);
    else
        await until(
            async () => (await rows()).some((row) => row.epoch === oldEpoch && row.target?.includes(fixture.chaId)),
            "old epoch snapshot",
        );
    await kill();
    await launch();
    await flush();
    const server = await readState(fixture);
    assert.equal(server.character.desc, "Original description", "old epoch never replayed");
    const drafts = await page.evaluate(async (chaId) => {
        const { recoveryDrafts } = await import("/src/ts/storage/recoveryDrafts.svelte.ts");
        return recoveryDrafts.entries.filter((entry) => entry.target.includes(chaId));
    }, fixture.chaId);
    let download;
    if (cut === "journal-held") {
        assert.equal(drafts.length, 0, "uncommitted old-epoch work lost; no exportable row");
    } else {
        assert(drafts.length > 0 && drafts.every((draft) => draft.otherEpoch), "other-epoch drafts listed");
        await page.getByRole("button", { name: "Review", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Recovered changes", exact: true });
        await dialog.waitFor();
        const row = dialog.locator("li").filter({ hasText: fixture.marker });
        // A record draft's label is its character name (the fixture marker).
        assert.equal(
            await row.getByRole("button", { name: "Apply", exact: true }).count(),
            0,
            "no Apply for another epoch",
        );
        const downloaded = page.waitForEvent("download");
        await row.getByRole("button", { name: "Export", exact: true }).click();
        const file = await downloaded;
        const json = JSON.parse(await readFile(await file.path(), "utf8"));
        assert(JSON.stringify(json).includes(fixture.marker), "export holds unsaved work");
        assert(
            json.drafts.some(
                (draft) =>
                    draft.epoch === oldEpoch &&
                    Object.values(draft.layers).some(
                        (layer) => layer.value.text && JSON.parse(layer.value.text).desc === fixture.marker,
                    ),
            ),
        );
        download = { filename: file.suggestedFilename(), drafts: json.drafts.length, holdsWork: true, applyButtons: 0 };
        await dialog.getByRole("button", { name: /Close/ }).click();
    }
    check(`other-epoch export / ${cut}${cut === "journal-held" ? " / documented uncommitted loss" : ""}`, true, {
        before,
        oldEpoch,
        newEpoch: restored.epoch,
        serverDesc: server.character.desc,
        drafts: briefRows(drafts),
        download,
    });
}
async function runMovedBase() {
    const fixture = await seed();
    const before = await cutWork("character", "before-commit", fixture);
    const record = await api(`/api/resources/characters/${fixture.chaId}`);
    await api("/api/resources/batch", {
        ops: [
            {
                kind: "characters",
                id: fixture.chaId,
                baseRevision: record.revision,
                data: { ...record.data, desc: "Remote winning description" },
            },
        ],
    });
    await kill();
    await launch();
    await flush();
    const state = await readState(fixture);
    assert.equal(state.character.desc, "Remote winning description");
    const drafts = (await rows()).filter((row) => row.type === "draft" && row.target?.includes(fixture.chaId));
    assert(
        drafts.some((row) => JSON.stringify(row.layers).includes(fixture.marker)),
        "moved base retains local work as draft",
    );
    check("moved base becomes draft", true, { before, serverDesc: state.character.desc, drafts: briefRows(drafts) });
}
async function runGracefulClose() {
    const fixture = await seed();
    const input = await openComposer(fixture);
    await input.fill("Committed composer");
    await until(
        async () => (await rows()).some((row) => row.type === "composer" && row.chatKey.includes(fixture.chaId)),
        "baseline composer commit",
    );
    const committed = briefRows((await rows()).filter((row) => rowFor(row, fixture, "composer")));
    // Await the final edits in page.evaluate, then immediately request a normal page close with
    // beforeunload enabled. Observe which fetch actually carries the edit; scheduling can let
    // either the ordinary cycle or the pagehide keepalive deliver it.
    const eventsAt = lifecycle.length;
    const transportsAt = transports.length;
    await page.evaluate(async (f) => {
        const chats = await import("/src/ts/storage/chatStore.svelte.ts");
        const input = document.querySelector("textarea.input-text");
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(input, f.marker);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        chats.setMessageText({ chaId: f.chaId, chatId: f.chatId }, f.messageId, f.marker);
    }, fixture);
    await page.close({ runBeforeUnload: true });
    await until(() => page.isClosed(), "graceful page close");
    // Read IndexedDB in an idle same-origin document without boot recovery changing its contents.
    page = await context.newPage();
    await page.goto(`${stack.baseURL}/sw/init`);
    const held = briefRows(
        (await rows()).filter((row) => row.target?.includes(fixture.chaId) || row.chatKey?.includes(fixture.chaId)),
    );
    const server = await until(async () => {
        const state = await readState(fixture);
        return state.chats.find((row) => row.id === fixture.chatId)?.data.message[0].data === fixture.marker && state;
    }, "graceful close edit reaches server");
    const carriesEdit = (body) =>
        body?.chats?.some(
            (group) =>
                group.characterId === fixture.chaId &&
                group.chatId === fixture.chatId &&
                group.ops.some(
                    (op) => op.op === "setText" && op.id === fixture.messageId && op.text === fixture.marker,
                ),
        );
    const requests = traffic.filter((entry) => carriesEdit(entry.body));
    assert(requests.length > 0, "the edit's batch request was observed");
    await until(
        () => transports.slice(transportsAt).some((entry) => entry.body && carriesEdit(JSON.parse(entry.body))),
        "native fetch transport flag captured",
    );
    const nativeFetches = transports
        .slice(transportsAt)
        .filter((entry) => entry.body && carriesEdit(JSON.parse(entry.body)));
    for (const request of requests) {
        request.nativeFetch = nativeFetches.find(
            (entry) => entry.url === request.url && entry.body === JSON.stringify(request.body),
        );
        assert(request.nativeFetch, "each edit-carrying request has its observed native fetch flag");
        if (request.nativeFetch.keepalive) {
            assert.deepEqual(Object.keys(request.body), ["chats"], "pagehide sends the chat-only keepalive body");
        } else {
            assert("ops" in request.body && "chatOrders" in request.body, "ordinary cycle sends its normal batch body");
        }
    }
    const flags = new Set(requests.map((entry) => entry.nativeFetch.keepalive));
    assert.equal(flags.size, 1, "server readback is attributable to one observed transport kind");
    const deliveredBy = flags.has(true) ? "pagehide keepalive" : "ordinary save cycle";
    assert(
        held.some((row) => row.type === "composer" && row.value.input === "Committed composer"),
        "pagehide-only composer edit lost; previous committed draft remains",
    );
    check(`graceful close / ${deliveredBy} / documented pagehide limit`, true, {
        events: lifecycle.slice(eventsAt),
        committedBeforeClose: committed,
        journalAfterClose: held,
        serverText: server.chats.find((row) => row.id === fixture.chatId).data.message[0].data,
        deliveredBy,
        batches: requests,
    });
    await openApp(page, stack.baseURL);
}
async function runBfcache() {
    await flush();
    const token = randomUUID();
    const locks = await page.evaluate(async (token) => {
        window.__durableDocument = token;
        return navigator.locks.query();
    }, token);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable");
    const evidence = [];
    const eventsAt = lifecycle.length;
    cdp.on("Page.backForwardCacheNotUsed", (event) => evidence.push(event));
    const history = await cdp.send("Page.getNavigationHistory");
    const appEntry = history.entries[history.currentIndex];
    await page.goto(`${stack.baseURL}/sw/init`);
    // A bfcache restore emits neither DOMContentLoaded nor load. Drive ordinary history traversal
    // without waiting for either, then inspect the returning document itself.
    await cdp.send("Page.navigateToHistoryEntry", { entryId: appEntry.id });
    await until(() => page.url() === appEntry.url, "history returned to app");
    await ready();
    const navigation = await page.evaluate(
        (token) => ({
            sameDocument: window.__durableDocument === token,
            navigationType: performance.getEntriesByType("navigation")[0]?.type,
            notRestoredReasons: performance.getEntriesByType("navigation")[0]?.notRestoredReasons?.toJSON() ?? null,
        }),
        token,
    );
    assert(
        locks.held.some((lock) => lock.name.startsWith("risu-journal-owner:")),
        "owner Web Lock held before navigating",
    );
    assert(
        navigation.sameDocument || navigation.notRestoredReasons || evidence.length > 0,
        "bfcache outcome has browser evidence",
    );
    check(`bfcache / ${navigation.sameDocument ? "restored" : "not restored"}`, true, {
        browser: context.browser()?.version(),
        headless: true,
        removedPlaywrightDefaultArgs: ["--disable-back-forward-cache"],
        pendingWritesAcrossReturn: false,
        locks,
        locksAfter: await page.evaluate(() => navigator.locks.query()),
        ...navigation,
        backForwardCacheNotUsed: evidence,
        lifecycle: lifecycle.slice(eventsAt),
    });
    await cdp.detach();
}

try {
    process.env.CHOKIDAR_USEPOLLING ??= "1";
    await rm(profile, { recursive: true, force: true });
    stack = await startStack({ serverPort: 6151, vitePort: 5251 });
    await launch();
    binding = chatBindingFixture(
        ...(await Promise.all(
            ["modelPresets", "presets", "personas"].map((kind) => api(`/api/resources/${kind}/main`)),
        )),
    );
    for (const kind of [
        "settings",
        "character",
        "message",
        "reorder",
        "trash",
        "chat-create",
        "composer",
        "recovery-again",
        "restore",
    ]) {
        for (const cut of cuts) {
            // A trash never enters the journal, so there is no journal transaction to hold.
            if (kind === "trash" && cut === "journal-held") continue;
            const name = `${kind} / ${cut}`;
            try {
                if (kind === "trash") await runTrash(cut);
                else if (kind === "recovery-again") await runRecoveryAgain(cut);
                else if (kind === "restore") await runRestore(cut);
                else await runMutation(kind, cut);
            } catch (error) {
                check(name, false, { error: String(error), stack: error.stack, traffic });
                // Leave a failed case intact in its evidence, then discard its live page. Never let
                // held work from a failed case bleed into the next case through lifecycle events.
                if (context) await kill();
                await launch();
            }
        }
    }
    for (const [name, run] of [
        ["moved base", runMovedBase],
        ["graceful close", runGracefulClose],
        ["bfcache", runBfcache],
    ]) {
        try {
            await run();
        } catch (error) {
            check(name, false, { error: String(error), stack: error.stack, traffic });
            if (context) await kill();
            await launch();
        }
    }
    const denied = await stack.deniedEgress();
    const unexpected = unexpectedEgress(blocked.flat(), denied);
    check("no unexpected egress", unexpected.length === 0, { unexpected });
} catch (error) {
    check("driver", false, { error: String(error), stack: error.stack });
} finally {
    if (context) await context.close();
    if (stack) await stack.stop();
    await rm(profile, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
