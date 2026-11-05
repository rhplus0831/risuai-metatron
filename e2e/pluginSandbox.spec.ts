import { createHash, randomUUID } from "node:crypto";
import type { Frame } from "@playwright/test";
import { expect, settle, test as base, type Page } from "./fixtures";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// The real v3 plugin sandbox keeps an opaque origin, rejects other windows, and reads unloaded chats.
// Covers src/ts/plugins/apiV3/factory.ts and src/ts/plugins/apiV3/v3.svelte.ts against the dev stack.
const pluginName = "BrowserSandboxProbe";
const pluginScript = `//@name ${pluginName}
//@api 3.0
const responses = [];
window.addEventListener('message', event => {
    if (event.data?.type === 'RESPONSE') responses.push(event.data.reqId);
});
globalThis.__sandboxProbe = {
    name: '${pluginName}',
    responses,
    async roundTrip(key, value) {
        await risuai.pluginStorage.setItem(key, value);
        return risuai.pluginStorage.getItem(key);
    },
    readStorage(key) { return risuai.pluginStorage.getItem(key); },
    readDatabase() { return risuai.getDatabase(['characters']); },
};
`;

type Api = (path: string, body?: unknown) => Promise<any>;
type Sandbox = { frame: Frame; chaId: string; api: Api };

const test = base.extend<{ sandbox: Sandbox }>({
    sandbox: async ({ page, baseURL }, use) => {
        await isolateContext(page.context());
        let auth = "";
        let epoch = "";
        page.on("request", (request) => {
            const headers = request.headers();
            if (headers["risu-auth"]) auth = headers["risu-auth"];
            if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        });
        page.on("response", (response) => {
            if (response.headers()["x-resource-epoch"]) epoch = response.headers()["x-resource-epoch"];
        });
        const api: Api = async (path, body) => {
            const response = await fetch(baseURL + path, {
                method: body === undefined ? "GET" : "POST",
                headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const result = await response.json();
            if (result.epoch) epoch = result.epoch;
            const optional = {
                "/api/resources/pluginPermissions/main": { grants: {}, lastGrantTime: {} },
                "/api/resources/pluginStorage/main": {},
            };
            if (response.status === 404 && body === undefined && Object.hasOwn(optional, path)) {
                return { revision: null, data: optional[path as keyof typeof optional] };
            }
            expect(response.status, `${path}: ${JSON.stringify(result)}`).toBe(200);
            return result;
        };
        await openApp(page, baseURL!);
        await expect.poll(() => Boolean(auth), { timeout: 30_000 }).toBe(true);
        await settle(page);

        const kinds = ["plugins", "pluginPermissions", "ui", "characterOrder", "pluginStorage"];
        const originals = new Map<string, any>();
        for (const kind of kinds) originals.set(kind, await api(`/api/resources/${kind}/main`));
        // Stop the old tab before seeding so it cannot save over the fixture or reload a partial seed.
        await page.goto("about:blank");
        const chaId = randomUUID();
        const grant = createHash("sha256").update(pluginScript).digest("hex") + "_db";
        const plugins = originals.get("plugins");
        const permissions = originals.get("pluginPermissions");
        const ui = originals.get("ui");
        const order = originals.get("characterOrder");
        await api("/api/resources/batch", {
            ops: [
                {
                    kind: "plugins",
                    id: "main",
                    baseRevision: plugins.revision,
                    data: [
                        ...plugins.data,
                        {
                            name: pluginName,
                            script: pluginScript,
                            version: "3.0",
                            enabled: true,
                            realArg: {},
                            arguments: {},
                            argMeta: {},
                            customLink: [],
                        },
                    ],
                },
                {
                    kind: "pluginPermissions",
                    id: "main",
                    baseRevision: permissions.revision,
                    data: {
                        grants: { ...permissions.data.grants, [grant]: true },
                        lastGrantTime: {
                            ...permissions.data.lastGrantTime,
                            [`${pluginName}_db_lastGrantTime`]: Date.now(),
                        },
                    },
                },
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true, enableDevTools: false },
                },
                {
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: {
                        chaId,
                        name: "Sandbox character",
                        type: "character",
                        firstMessage: "Hello",
                        desc: "",
                        notes: "",
                        emotionImages: [],
                        bias: [],
                        viewScreen: "none",
                        globalLore: [],
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
                    },
                },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...order.data, chaId],
                },
            ],
            chats: ["selected", "unloaded"].map((chatId) => ({
                characterId: chaId,
                chatId,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: chatId,
                            name: chatId,
                            message: [{ role: "user", data: `${chatId} sandbox message`, chatId: `${chatId}-message` }],
                        },
                    },
                ],
            })),
        });
        try {
            await openApp(page, baseURL!);
            let frame: Frame | undefined;
            await expect
                .poll(
                    async () => {
                        for (const candidate of page.frames()) {
                            if (
                                await candidate
                                    .evaluate((name) => (globalThis as any).__sandboxProbe?.name === name, pluginName)
                                    .catch(() => false)
                            ) {
                                frame = candidate;
                                return true;
                            }
                        }
                        return false;
                    },
                    { timeout: 30_000, message: "the installed v3 plugin initialized its real guest bridge" },
                )
                .toBe(true);
            await settle(page);
            await use({ frame: frame!, chaId, api });
        } finally {
            await settle(page);
            await page.goto("about:blank");
            const character = await api(`/api/resources/characters/${chaId}`);
            const ops: any[] = [{ kind: "characters", id: chaId, baseRevision: character.revision, delete: true }];
            for (const kind of kinds) {
                const current = await api(`/api/resources/${kind}/main`);
                ops.push({ kind, id: "main", baseRevision: current.revision, data: originals.get(kind).data });
            }
            await api("/api/resources/batch", { ops });
        }
    },
});

const hostStorage = (page: Page, key: string) =>
    page.evaluate(async (key) => {
        const { getPluginStorageValue } = await import("/src/ts/storage/pluginStorageStore.svelte.ts");
        return getPluginStorageValue(key);
    }, key);

test("the plugin iframe has exactly the allowed sandbox tokens and an opaque origin", async ({ sandbox }) => {
    const element = await sandbox.frame.frameElement();
    const tokens = await element.evaluate((iframe: HTMLIFrameElement) => Array.from(iframe.sandbox));
    expect
        .soft(new Set(tokens), "sandbox token set")
        .toEqual(new Set(["allow-scripts", "allow-modals", "allow-downloads"]));
    expect.soft(await sandbox.frame.evaluate(() => self.origin), "origin read inside the plugin guest").toBe("null");
});

test("other windows cannot write plugin storage or get an RPC answer, while the real bridge round trips", async ({
    page,
    sandbox: { frame, api },
}) => {
    const key = `sandbox-${randomUUID()}`;
    const reqId = `forged-${randomUUID()}`;
    const value = { text: "bridge value", count: 42 };
    expect(await hostStorage(page, key)).toBeNull();
    await page.evaluate(
        ({ key, reqId, value }) =>
            new Promise<void>((resolve) => {
                const responses: string[] = [];
                (window as any).__forgedResponses = responses;
                window.addEventListener("message", (event) => {
                    if (event.data?.type === "RESPONSE" && event.data.reqId === reqId) responses.push(reqId);
                    if (event.source === window && event.data?.type === "CALL_ROOT" && event.data.reqId === reqId) {
                        // The existing host listener runs before this observer on the same message event.
                        resolve();
                    }
                });
                window.postMessage({ type: "CALL_ROOT", reqId, method: "_setPluginStorage", args: [key, value] }, "*");
            }),
        { key, reqId, value },
    );
    // A genuine write/read answer bounds the negative check after dispatch of the forged message.
    expect(
        await frame.evaluate(() => (globalThis as any).__sandboxProbe.roundTrip("sandbox-barrier", "answered")),
    ).toBe("answered");
    expect.soft(await hostStorage(page, key), "the forged write had no host effect").toBeNull();
    expect.soft(await frame.evaluate((key) => (globalThis as any).__sandboxProbe.readStorage(key), key)).toBeNull();
    expect
        .soft(await page.evaluate(() => (window as any).__forgedResponses), "no answer to the top-window sender")
        .toEqual([]);
    expect
        .soft(
            await frame.evaluate(
                (id) => (globalThis as any).__sandboxProbe.responses.filter((req: string) => req === id),
                reqId,
            ),
            "no forged-call answer sent to the plugin either",
        )
        .toEqual([]);

    // The exact same storage write through the real risuai API succeeds and returns the host value.
    expect(
        await frame.evaluate(({ key, value }) => (globalThis as any).__sandboxProbe.roundTrip(key, value), {
            key,
            value,
        }),
    ).toEqual(value);
    expect(await hostStorage(page, key)).toEqual(value);
    await settle(page);
    expect((await api("/api/resources/pluginStorage/main")).data._pluginStorage[key]).toEqual(value);
});

test("getDatabase outside a hook returns messages from an unloaded member chat without installing it", async ({
    page,
    sandbox: { frame, chaId, api },
}) => {
    const held = () =>
        page.evaluate(async (chaId) => {
            const store = await import("/src/ts/storage/chatStore.svelte.ts");
            return {
                members: store.chatList(chaId).map((chat: any) => chat.id),
                allLoaded: store.chatsLoaded(chaId),
                loaded: store
                    .chatList(chaId)
                    .filter((chat: any) => store.findChat({ chaId, chatId: chat.id }))
                    .map((chat: any) => chat.id),
            };
        }, chaId);
    const before = await held();
    expect(before.members).toEqual(["selected", "unloaded"]);
    expect(before.allLoaded).toBe(false);
    expect(before.loaded).not.toContain("unloaded");
    const saved = await api("/api/resources/read", { chats: [{ characterId: chaId, id: "unloaded" }] });
    expect(saved.chats[0].data.message).toEqual([
        { role: "user", data: "unloaded sandbox message", chatId: "unloaded-message" },
    ]);

    // This method is invoked directly in the guest, with no hook registered or running.
    const result = await frame.evaluate(() => (globalThis as any).__sandboxProbe.readDatabase());
    const character = result.characters.find((character: any) => character.chaId === chaId);
    expect(character?.chats.map((chat: any) => chat.id)).toEqual(["selected", "unloaded"]);
    expect(character?.chats.find((chat: any) => chat.id === "unloaded")?.message).toEqual(saved.chats[0].data.message);
    expect(await held()).toEqual(before);
});
