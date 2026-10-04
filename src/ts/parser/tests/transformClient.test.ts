import { flushSync } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client of the server script transform (Phase 5 slice 13b, `src/ts/parser/transformClient.ts`):
// context capture, batching and splitting, exactly-once settlement with one toast per batch, the
// two-call protocol with the tab's plugin handlers and its deadlines, the Re-render cache bypass, and
// the emotion effects. Everything the module talks to is mocked: the server is a function of the
// request (`state.handler`), the chat module a few maps. The module is imported once (its state is
// per document), so every test uses its own chat or message ids. Timers are fake: a batch goes out on
// the 16 ms timer (the animation frame is withheld unless a test runs it), and the deadlines are the
// real 28 s / 23 s.

type Reply = { status?: number; body: unknown };
type Handler = (path: string, body: any) => Reply | Promise<Reply>;

const state = vi.hoisted(() => ({
    current: null as { chaId: string; chatId: string } | null,
    chats: new Map<string, { message: { chatId: string }[]; bindedPersona?: string }>(),
    held: new Set<string>(),
    locked: new Set<string>(),
    preset: "preset-1" as string | undefined,
    persona: "persona-1" as string | undefined,
    bound: undefined as string | undefined,
    handler: null as unknown as (path: string, body: any) => unknown,
    calls: [] as { path: string; body: any; headers: Record<string, string> }[],
    hookContexts: [] as unknown[],
    toasts: [] as string[],
    epochs: [] as string[],
    hooks: { editdisplay: new Set<(text: string) => unknown>(), editprocess: new Set<(text: string) => unknown>() },
}));

const key = (ref: { chaId: string; chatId: string }) => `${ref.chaId}/${ref.chatId}`;

vi.mock("src/lang", () => ({ language: { serverTransformFailed: "Render failed" } }));
vi.mock("../../alert", () => ({ alertToast: (text: string) => state.toasts.push(text) }));
vi.mock("../../network/generationJobs", () => ({ generationClientId: () => "client-1" }));
vi.mock("../../plugins/apiV3/pluginContext", () => ({
    capturePluginContext: (ref: { chaId: string; chatId: string } | null) =>
        ref ? { chatRef: ref, presetId: state.preset ?? "", personaId: state.bound ?? state.persona ?? "" } : undefined,
    invokeHook: (hook: (text: string) => unknown, context: unknown, text: string) => {
        state.hookContexts.push(context);
        return hook(text);
    },
}));
vi.mock("../../plugins/pluginHooks", () => ({ pluginHooks: state.hooks }));
vi.mock("../../storage/chatStore.svelte", async () => {
    const { lockSource } = await import("./transformReactive.svelte");
    return {
        currentChatRef: () => state.current,
        findChat: (ref: { chaId: string; chatId: string }) => state.chats.get(key(ref)),
        heldChatRevision: (ref: { chaId: string; chatId: string }) => (state.held.has(key(ref)) ? "rev-1" : null),
        isMessageLocked: (ref: { chaId: string; chatId: string } | null, messageId: string | undefined) => {
            void lockSource.version;
            return ref !== null && messageId !== undefined && state.locked.has(`${key(ref)}/${messageId}`);
        },
    };
});
vi.mock("../../stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { CharEmotion: writable({}), DBState: { db: {} } };
});
vi.mock("../../storage/forwarding.svelte", () => ({
    selectedPreset: () => (state.preset ? { id: state.preset } : undefined),
    selectedPersona: () => (state.persona ? { id: state.persona } : undefined),
}));
vi.mock("../../storage/nodeStorage", () => ({
    authFetch: async (path: string, init: { body: string; headers: Record<string, string> }) => {
        const body = JSON.parse(init.body);
        state.calls.push({ path, body, headers: init.headers });
        const reply = (await state.handler(path, body)) as Reply;
        const status = reply.status ?? 200;
        return { status, ok: status < 400, json: async () => reply.body };
    },
}));
vi.mock("../../storage/resourceClient", () => ({
    getResourceEpoch: () => "epoch-1",
    epochMismatch: (epoch: string) => {
        state.epochs.push(epoch);
        return new Error(`EpochMismatch ${epoch}`);
    },
}));
vi.mock("../../util", () => ({ checkPersonaBinded: () => (state.bound ? { id: state.bound } : undefined) }));

import { CharEmotion } from "../../stores.svelte";
import {
    captureTransform,
    rerenderMessage,
    resetTransformEffects,
    serverProcessScript,
    type CapturedTransform,
} from "../transformClient";
import { createProbe } from "../../storage/tests/reactiveProbe.svelte";
import { lockSource } from "./transformReactive.svelte";

const ok = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id,
    ok: true,
    text,
    emotions: [],
    key: `key:${text}`,
    cached: false,
    ...extra,
});

/** The default server: no handlers, every target answered `<source>`; with handlers, every target pending. */
const defaultHandler: Handler = (path, body) => {
    if (path === "/api/transform/continue") {
        return {
            body: {
                results: body.texts.map((t: any) =>
                    "error" in t ? { id: t.id, ok: false, error: t.error } : ok(t.id, `post(${t.text})`),
                ),
            },
        };
    }
    if (body.handlers) {
        return {
            body: {
                results: [],
                snapshotId: "snap-1",
                pending: body.targets.map((t: any) => ({ id: t.id, text: `pre(${t.source})` })),
            },
        };
    }
    return { body: { results: body.targets.map((t: any) => ok(t.id, `<${t.source}>`)) } };
};

let chatCounter = 0;
/** A fresh saved chat (selected) with `count` messages `m0..`. */
function newChat(count = 3) {
    const ref = { chaId: `cha-${++chatCounter}`, chatId: `chat-${chatCounter}` };
    state.chats.set(key(ref), { message: Array.from({ length: count }, (_, i) => ({ chatId: `m${i}` })) });
    state.held.add(key(ref));
    state.current = ref;
    return ref;
}

const char = (chaId: string, type = "character") => ({ chaId, type });
const transformPosts = () => state.calls.filter((call) => call.path === "/api/transform");
const continuePosts = () => state.calls.filter((call) => call.path === "/api/transform/continue");
const settledFlag = <T>(promise: Promise<T>) => {
    const view = { done: false, value: undefined as T | undefined };
    void promise.then((value) => {
        view.done = true;
        view.value = value;
    });
    return view;
};
/** Lets the 16 ms batch timer fire and the answers run. */
const flush = () => vi.advanceTimersByTimeAsync(20);

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    state.preset = "preset-1";
    state.persona = "persona-1";
    state.bound = undefined;
    state.locked.clear();
    state.calls.length = 0;
    state.hookContexts.length = 0;
    state.toasts.length = 0;
    state.epochs.length = 0;
    state.hooks.editdisplay.clear();
    state.hooks.editprocess.clear();
    state.handler = defaultHandler;
    frames = [];
    // Frames are withheld (a hidden tab) unless a test runs them.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    CharEmotion.set({});
    resetTransformEffects();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("captureTransform", () => {
    it("answers null for a chat the server has not stored, and without a preset or persona", () => {
        const ref = newChat();
        state.held.delete(key(ref));
        expect(captureTransform(0)).toBeNull();
        state.held.add(key(ref));
        state.preset = undefined;
        expect(captureTransform(0)).toBeNull();
        state.preset = "preset-1";
        state.persona = undefined;
        expect(captureTransform(0)).toBeNull();
        state.current = null;
        state.persona = "persona-1";
        expect(captureTransform(0)).toBeNull();
    });

    it("captures the chat, the message id at the index, the preset, the effective and selected persona, and the lock", () => {
        const ref = newChat();
        state.bound = "persona-bound";
        state.locked.add(`${key(ref)}/m1`);
        const captured = captureTransform(1)!;
        expect(captured.context).toEqual({
            characterId: ref.chaId,
            chatId: ref.chatId,
            presetId: "preset-1",
            personaId: "persona-bound",
            selectedPersonaId: "persona-1",
        });
        expect(captured.messageId).toBe("m1");
        expect(captured.locked).toBe(true);
        expect(captured.noCache).toBe(false);
        expect(captured.pluginContext).toEqual({ chatRef: ref, presetId: "preset-1", personaId: "persona-bound" });
        const greeting = captureTransform(-1)!;
        expect(greeting.messageId).toBeUndefined();
        expect(greeting.locked).toBe(false);
    });

    it("prefers a given plugin context's chat, preset, and persona over the selection", () => {
        const selected = newChat();
        const other = newChat();
        state.current = selected;
        const pluginContext = { chatRef: other, presetId: "preset-hook", personaId: "persona-hook" };
        const captured = captureTransform(0, { pluginContext })!;
        expect(captured.chatRef).toEqual(other);
        expect(captured.context).toMatchObject({
            characterId: other.chaId,
            chatId: other.chatId,
            presetId: "preset-hook",
            personaId: "persona-hook",
            selectedPersonaId: "persona-1",
        });
        expect(captured.pluginContext).toBe(pluginContext);
    });

    it("does not make a reactive computation depend on the lock state (a lock change elsewhere re-renders no row)", () => {
        const ref = newChat();
        const capturing = createProbe(() => captureTransform(0)?.messageId);
        // The control: the same lock reader read directly is tracked.
        const control = createProbe(() => lockSource.version);
        expect(capturing.seen).toEqual(["m0"]);
        lockSource.version += 1;
        flushSync();
        lockSource.version += 1;
        flushSync();
        expect(control.seen).toHaveLength(3);
        expect(capturing.seen).toEqual(["m0"]);
        capturing.dispose();
        control.dispose();
        expect(ref).toBeTruthy();
    });
});

describe("batching and splitting", () => {
    it("batches a frame's calls into one request, shares identical targets, and maps the target kinds", async () => {
        const ref = newChat();
        const captured = captureTransform(1)!;
        const greeting = captureTransform(-1)!;
        const a = serverProcessScript(
            char(ref.chaId),
            "A",
            "editdisplay",
            1,
            { chatRole: "char" },
            captured,
            "message",
        );
        const b = serverProcessScript(
            char(ref.chaId),
            "A",
            "editdisplay",
            1,
            { chatRole: "char" },
            captured,
            "message",
        );
        const c = serverProcessScript(
            char(ref.chaId),
            "G",
            "editdisplay",
            -1,
            { firstmsg: true, chatRole: null },
            greeting,
            "message",
        );
        const d = serverProcessScript(char(ref.chaId), "B", "editdisplay", 1, {}, captured, "background");
        const e = serverProcessScript(char(ref.chaId), "T", "editdisplay", 1, {}, captured, "translation");
        await flush();
        expect(await Promise.all([a, b, c, d, e])).toEqual([
            { data: "<A>", emoChanged: false },
            { data: "<A>", emoChanged: false },
            { data: "<G>", emoChanged: false },
            { data: "<B>", emoChanged: false },
            { data: "<T>", emoChanged: false },
        ]);
        expect(transformPosts()).toHaveLength(1);
        const { body, headers } = transformPosts()[0];
        expect(headers["x-resource-epoch"]).toBe("epoch-1");
        expect(body).toMatchObject({ clientId: "client-1", mode: "editdisplay", context: captured.context });
        expect(body.handlers).toBeUndefined();
        expect(
            body.targets.map((t: any) => [t.kind, t.messageId, t.chatIndex, t.source, t.cbsConditions, t.sourceId]),
        ).toEqual([
            ["message", "m1", 1, "A", { chatRole: "char" }, ref.chaId],
            // A null condition is not sent; the greeting has no message id.
            ["text", undefined, -1, "G", { firstmsg: true }, ref.chaId],
            ["background", undefined, 1, "B", {}, ref.chaId],
            ["translation", undefined, 1, "T", {}, ref.chaId],
        ]);
        expect(new Set(body.targets.map((t: any) => t.id)).size).toBe(4);
        expect(state.toasts).toEqual([]);
    });

    it("keeps targets with different indexes or conditions apart, and separates contexts and modes into requests", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.preset = "preset-2";
        const otherPreset = captureTransform(0)!;
        const calls = [
            serverProcessScript(char(ref.chaId), "X", "editdisplay", 0, {}, captured, "message"),
            serverProcessScript(char(ref.chaId), "X", "editdisplay", 2, {}, captured, "text"),
            serverProcessScript(char(ref.chaId), "X", "editdisplay", 0, { chatRole: "user" }, captured, "message"),
            serverProcessScript(char(ref.chaId), "X", "editdisplay", 0, {}, otherPreset, "message"),
            serverProcessScript(char(ref.chaId), "X", "editprocess", 0, {}, captured, "message"),
        ];
        await flush();
        await Promise.all(calls);
        const posts = transformPosts();
        expect(posts.map((p) => [p.body.mode, p.body.context.presetId, p.body.targets.length])).toEqual([
            ["editdisplay", "preset-1", 3],
            ["editdisplay", "preset-2", 1],
            ["editprocess", "preset-1", 1],
        ]);
    });

    it("dispatches on the next frame when frames run, once (the timer is cancelled)", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        const call = serverProcessScript(char(ref.chaId), "F", "editdisplay", 0, {}, captured, "message");
        expect(frames).toHaveLength(1);
        frames[0](0);
        await vi.advanceTimersByTimeAsync(0);
        expect(transformPosts()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(50);
        expect(transformPosts()).toHaveLength(1);
        expect(await call).toEqual({ data: "<F>", emoChanged: false });
    });

    it("splits 65 targets into 64 and 1, and answers all", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        const calls = Array.from({ length: 65 }, (_, i) =>
            serverProcessScript(char(ref.chaId), `t${i}`, "editdisplay", 0, {}, captured, "message"),
        );
        await flush();
        const answers = await Promise.all(calls);
        expect(transformPosts().map((p) => p.body.targets.length)).toEqual([64, 1]);
        expect(answers.map((a) => a.data)).toEqual(Array.from({ length: 65 }, (_, i) => `<t${i}>`));
    });

    it("splits at 4 MiB of UTF-8 and fails a text over 512 KiB alone, without a request, with one toast", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        // 512 KiB exactly (ASCII) is allowed; 174,763 three-byte characters are 524,289 bytes, one over.
        const atLimit = "a".repeat(512 * 1024);
        const overByOne = "한".repeat(174_763);
        const nineAtLimit = Array.from({ length: 9 }, (_, i) => `${i}`.padEnd(512 * 1024, "b"));
        const over = serverProcessScript(char(ref.chaId), overByOne, "editdisplay", 0, {}, captured, "message");
        const fits = serverProcessScript(char(ref.chaId), atLimit, "editdisplay", 0, {}, captured, "message");
        const rest = nineAtLimit.map((text) =>
            serverProcessScript(char(ref.chaId), text, "editdisplay", 0, {}, captured, "message"),
        );
        await flush();
        expect(await over).toEqual({ data: overByOne, emoChanged: false });
        expect((await fits).data).toBe(`<${atLimit}>`);
        expect((await Promise.all(rest)).map((a) => a.data)).toEqual(nineAtLimit.map((text) => `<${text}>`));
        // 10 texts of 512 KiB: 8 fit in 4 MiB, then 2.
        expect(transformPosts().map((p) => p.body.targets.length)).toEqual([8, 2]);
        expect(transformPosts().some((p) => p.body.targets.some((t: any) => t.source === overByOne))).toBe(false);
        expect(state.toasts).toEqual(["Render failed: The text is too long to render"]);
    });

    it("answers a failed target with its own text and keeps the others, with one toast", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = (_path, body) => ({
            body: {
                results: body.targets.map((t: any) =>
                    t.source === "bad" ? { id: t.id, ok: false, error: "Lua budget exceeded" } : ok(t.id, "fine"),
                ),
            },
        });
        const bad = serverProcessScript(char(ref.chaId), "bad", "editdisplay", 0, {}, captured, "message");
        const good = serverProcessScript(char(ref.chaId), "good", "editdisplay", 0, {}, captured, "message");
        const bad2 = serverProcessScript(char(ref.chaId), "bad", "editdisplay", 2, {}, captured, "text");
        await flush();
        expect((await bad).data).toBe("bad");
        expect((await bad2).data).toBe("bad");
        expect((await good).data).toBe("fine");
        expect(state.toasts).toEqual(["Render failed: Lua budget exceeded"]);
    });

    it("answers every target raw on a failed request, one toast for the batch across its chunks", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = () => ({ status: 500, body: { error: "Boom" } });
        const calls = Array.from({ length: 65 }, (_, i) =>
            serverProcessScript(char(ref.chaId), `t${i}`, "editdisplay", 0, {}, captured, "message"),
        );
        await flush();
        const answers = await Promise.all(calls);
        expect(answers.map((a) => a.data)).toEqual(Array.from({ length: 65 }, (_, i) => `t${i}`));
        expect(transformPosts()).toHaveLength(2);
        expect(state.toasts).toEqual(["Render failed: Boom"]);
    });

    it("hands a 412 EpochMismatch to the epoch handler and answers raw", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = () => ({ status: 412, body: { error: "EpochMismatch", epoch: "epoch-2" } });
        const call = serverProcessScript(char(ref.chaId), "E", "editdisplay", 0, {}, captured, "message");
        await flush();
        expect((await call).data).toBe("E");
        expect(state.epochs).toEqual(["epoch-2"]);
    });

    it("answers a target the server left out as failed (exactly once), and ignores duplicates and unknown ids", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = (_path, body) => {
            const [first] = body.targets;
            return { body: { results: [ok(first.id, "one"), ok(first.id, "again"), ok("unknown", "x")] } };
        };
        const a = serverProcessScript(char(ref.chaId), "a", "editdisplay", 0, {}, captured, "message");
        const b = serverProcessScript(char(ref.chaId), "b", "editdisplay", 0, {}, captured, "message");
        await flush();
        expect((await a).data).toBe("one");
        expect((await b).data).toBe("b");
        expect(state.toasts).toEqual(["Render failed: The render did not answer"]);
    });

    it("skips a locked message: the text as it came in, no request", async () => {
        const ref = newChat();
        state.locked.add(`${key(ref)}/m0`);
        const captured = captureTransform(0)!;
        const call = serverProcessScript(char(ref.chaId), "raw", "editdisplay", 0, {}, captured, "message");
        await flush();
        expect(await call).toEqual({ data: "raw", emoChanged: false });
        expect(state.calls).toHaveLength(0);
    });
});

describe("plugin handlers (the two calls)", () => {
    it("sends a bounded handler-set id that changes with the ordered hook list", async () => {
        const ref = newChat();
        const ids: string[] = [];
        const send = async () => {
            const call = serverProcessScript(
                char(ref.chaId),
                "h",
                "editdisplay",
                0,
                {},
                captureTransform(0)!,
                "message",
            );
            await flush();
            await call;
            ids.push(transformPosts().at(-1)!.body.handlers);
        };
        const first = (text: string) => text + "1";
        const second = (text: string) => text + "2";
        state.hooks.editdisplay.add(first);
        await send();
        await send();
        state.hooks.editdisplay.add(second);
        await send();
        state.hooks.editdisplay.delete(first);
        state.hooks.editdisplay.add(first);
        await send();
        for (let i = 0; i < 100; i++) {
            state.hooks.editdisplay.add((text: string) => text + i);
        }
        await send();
        expect(ids[0]).toMatch(/^[0-9a-f-]{36}:editdisplay:\d+$/);
        expect(ids[1]).toBe(ids[0]);
        expect(new Set([ids[0], ids[2], ids[3], ids[4]]).size).toBe(4);
        expect(Math.max(...ids.map((id) => id.length))).toBeLessThanOrEqual(256);
    });

    it("runs each pending text's handlers in order with the captured plugin context, then sends the second call", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.hooks.editdisplay.add((text) => `${text}+1`);
        state.hooks.editdisplay.add(async (text) => `${text}+2`);
        state.hooks.editdisplay.add(() => undefined);
        const call = serverProcessScript(char(ref.chaId), "S", "editdisplay", 0, {}, captured, "message");
        await flush();
        expect(await call).toEqual({ data: "post(pre(S)+1+2)", emoChanged: false });
        expect(continuePosts()).toHaveLength(1);
        expect(continuePosts()[0].body).toEqual({
            clientId: "client-1",
            snapshotId: "snap-1",
            texts: [{ id: transformPosts()[0].body.targets[0].id, text: "pre(S)+1+2" }],
        });
        expect(state.hookContexts).toEqual([captured.pluginContext, captured.pluginContext, captured.pluginContext]);
    });

    it("keeps a handler result that is the word `expired`, and fails only the target whose handler threw", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.hooks.editdisplay.add((text) => {
            if (text === "pre(throw)") {
                throw new Error("hook failed");
            }
            return text === "pre(word)" ? "expired" : text;
        });
        const word = serverProcessScript(char(ref.chaId), "word", "editdisplay", 0, {}, captured, "message");
        const thrown = serverProcessScript(char(ref.chaId), "throw", "editdisplay", 0, {}, captured, "message");
        await flush();
        expect((await word).data).toBe("post(expired)");
        expect((await thrown).data).toBe("throw");
        const texts = continuePosts()[0].body.texts;
        expect(texts.map((t: any) => ("error" in t ? `error:${t.error}` : t.text))).toEqual([
            "expired",
            "error:hook failed",
        ]);
        expect(state.toasts).toEqual(["Render failed: hook failed"]);
    });

    it("answers a phase-1 result at once while another target's handler is still running", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        let release: (text: string) => void = () => {};
        state.hooks.editdisplay.add((text) => new Promise<string>((resolve) => (release = () => resolve(text))));
        state.handler = (path, body) =>
            path === "/api/transform"
                ? {
                      body: {
                          results: [ok(body.targets[0].id, "cached", { cached: true })],
                          snapshotId: "snap-1",
                          pending: [{ id: body.targets[1].id, text: "pre" }],
                      },
                  }
                : defaultHandler(path, body);
        const cached = settledFlag(
            serverProcessScript(char(ref.chaId), "c", "editdisplay", 0, {}, captured, "message"),
        );
        const pending = settledFlag(
            serverProcessScript(char(ref.chaId), "p", "editdisplay", 0, {}, captured, "message"),
        );
        await flush();
        expect(cached).toEqual({ done: true, value: { data: "cached", emoChanged: false } });
        expect(pending.done).toBe(false);
        release("pre");
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toEqual({ done: true, value: { data: "post(pre)", emoChanged: false } });
    });

    it("fails a hung handler's target at the handler deadline, sends the healthy text, and starts no later handler", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        let releaseHung: (text: string) => void = () => {};
        const laterCalls: string[] = [];
        state.hooks.editdisplay.add((text) =>
            text === "pre(hung)" ? new Promise<string>((resolve) => (releaseHung = resolve)) : text,
        );
        state.hooks.editdisplay.add((text) => {
            laterCalls.push(text);
            return `${text}!`;
        });
        const hung = settledFlag(
            serverProcessScript(char(ref.chaId), "hung", "editdisplay", 0, {}, captured, "message"),
        );
        const healthy = settledFlag(
            serverProcessScript(char(ref.chaId), "ok", "editdisplay", 0, {}, captured, "message"),
        );
        await flush();
        expect(continuePosts()).toHaveLength(0);
        // The handlers end 23 s after the chunk began (28 s, less the 5 s kept for the second call).
        await vi.advanceTimersByTimeAsync(22_900);
        expect(continuePosts()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(continuePosts()).toHaveLength(1);
        expect(continuePosts()[0].body.texts.map((t: any) => ("error" in t ? `error:${t.error}` : t.text))).toEqual([
            "error:A plugin handler took too long",
            "pre(ok)!",
        ]);
        expect(hung).toEqual({ done: true, value: { data: "hung", emoChanged: false } });
        expect(healthy).toEqual({ done: true, value: { data: "post(pre(ok)!)", emoChanged: false } });
        releaseHung("late");
        await vi.advanceTimersByTimeAsync(0);
        expect(laterCalls).toEqual(["pre(ok)"]);
        expect(state.toasts).toEqual(["Render failed: A plugin handler took too long"]);
    });

    it("runs no handler and sends no second call when the first call answers after the handler deadline", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        let hookCalls = 0;
        state.hooks.editdisplay.add((text) => {
            hookCalls += 1;
            return text;
        });
        state.handler = (path, body) =>
            new Promise((resolve) =>
                setTimeout(
                    () =>
                        resolve({
                            body: {
                                results: [ok(body.targets[0].id, "cached", { cached: true })],
                                snapshotId: "snap-1",
                                pending: [{ id: body.targets[1].id, text: "pre" }],
                            },
                        }),
                    24_000,
                ),
            );
        const cached = serverProcessScript(char(ref.chaId), "c", "editdisplay", 0, {}, captured, "message");
        const pending = serverProcessScript(char(ref.chaId), "p", "editdisplay", 0, {}, captured, "message");
        await flush();
        await vi.advanceTimersByTimeAsync(24_100);
        expect((await cached).data).toBe("cached");
        expect((await pending).data).toBe("p");
        expect(hookCalls).toBe(0);
        expect(continuePosts()).toHaveLength(0);
        expect(state.toasts).toEqual(["Render failed: The render took too long"]);
    });

    it("settles every caller within the chunk's 28 s when the request never answers (authentication or body stalled)", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = () => new Promise(() => {});
        const calls = ["a", "b"].map((text) =>
            settledFlag(serverProcessScript(char(ref.chaId), text, "editdisplay", 0, {}, captured, "message")),
        );
        await flush();
        await vi.advanceTimersByTimeAsync(27_900);
        expect(calls.map((c) => c.done)).toEqual([false, false]);
        await vi.advanceTimersByTimeAsync(200);
        expect(calls.map((c) => c.value?.data)).toEqual(["a", "b"]);
        expect(state.toasts).toEqual(["Render failed: The render took too long"]);
    });
});

describe("Re-render (the cache bypass)", () => {
    const send = async (ref: { chaId: string }, captured: CapturedTransform, text = "r") => {
        const call = serverProcessScript(char(ref.chaId), text, "editdisplay", 0, {}, captured, "message");
        await flush();
        await call;
        return transformPosts().at(-1)!.body.targets.at(-1);
    };

    it("bypasses the cache for the first render sent after a Re-render, and only that one", async () => {
        const ref = newChat();
        expect((await send(ref, captureTransform(0)!)).noCache).toBeUndefined();
        rerenderMessage(ref, "m0");
        expect((await send(ref, captureTransform(0)!)).noCache).toBe(true);
        expect((await send(ref, captureTransform(0)!)).noCache).toBeUndefined();
        // Another message of the chat is not affected.
        rerenderMessage(ref, "m1");
        expect((await send(ref, captureTransform(0)!)).noCache).toBeUndefined();
    });

    it("an older render still in flight cannot take a newer Re-render's bypass", async () => {
        const ref = newChat();
        const old = captureTransform(0)!;
        rerenderMessage(ref, "m0");
        const fresh = captureTransform(0)!;
        expect((await send(ref, old, "old")).noCache).toBeUndefined();
        expect((await send(ref, fresh, "new")).noCache).toBe(true);
    });

    it("a locked or unused capture leaves the bypass for the next render that is sent", async () => {
        const ref = newChat();
        rerenderMessage(ref, "m0");
        captureTransform(0);
        state.locked.add(`${key(ref)}/m0`);
        const locked = captureTransform(0)!;
        await serverProcessScript(char(ref.chaId), "x", "editdisplay", 0, {}, locked, "message");
        expect(state.calls).toHaveLength(0);
        state.locked.clear();
        expect((await send(ref, captureTransform(0)!)).noCache).toBe(true);
    });

    it("every stage of the render that took the bypass skips the cache too", async () => {
        const ref = newChat();
        rerenderMessage(ref, "m0");
        const captured = captureTransform(0)!;
        const pretranslate = serverProcessScript(char(ref.chaId), "one", "editdisplay", 0, {}, captured, "message");
        const translation = serverProcessScript(char(ref.chaId), "two", "editdisplay", 0, {}, captured, "translation");
        await flush();
        await Promise.all([pretranslate, translation]);
        expect(transformPosts()[0].body.targets.map((t: any) => t.noCache)).toEqual([true, true]);
        expect(captured.noCache).toBe(true);
    });
});

describe("emotion effects", () => {
    const emotional =
        (name: string, resultKey: string): Handler =>
        (_path, body) => ({
            body: {
                results: body.targets.map((t: any) =>
                    ok(t.id, t.source, { emotions: [{ name, image: `${name}.png` }], key: resultKey }),
                ),
            },
        });

    it("applies a result's emotions once per key, as the tab's process cache does, and again after a reset", async () => {
        const ref = newChat();
        state.handler = emotional("happy", "key-emo-1");
        const run = async () => {
            const call = serverProcessScript(
                char(ref.chaId),
                "e",
                "editprocess",
                0,
                {},
                captureTransform(0)!,
                "message",
            );
            await flush();
            return call;
        };
        expect((await run()).emoChanged).toBe(true);
        expect((get(CharEmotion) as any)[ref.chaId].map((e: any) => e.slice(0, 2))).toEqual([["happy", "happy.png"]]);
        expect((await run()).emoChanged).toBe(false);
        expect((get(CharEmotion) as any)[ref.chaId]).toHaveLength(1);
        resetTransformEffects();
        expect((await run()).emoChanged).toBe(true);
        expect((get(CharEmotion) as any)[ref.chaId]).toHaveLength(2);
    });

    it("keeps at most five emotions per character", async () => {
        const ref = newChat();
        for (let i = 0; i < 7; i++) {
            state.handler = emotional(`e${i}`, `key-trim-${i}`);
            const call = serverProcessScript(
                char(ref.chaId),
                `t${i}`,
                "editprocess",
                0,
                {},
                captureTransform(0)!,
                "message",
            );
            await flush();
            await call;
        }
        expect((get(CharEmotion) as any)[ref.chaId].map((e: any) => e[0])).toEqual(["e2", "e3", "e4", "e5", "e6"]);
    });

    it("applies none for a simple character argument", async () => {
        const ref = newChat();
        state.handler = emotional("sad", "key-simple");
        const call = serverProcessScript(
            char(ref.chaId, "simple"),
            "s",
            "editdisplay",
            0,
            {},
            captureTransform(0)!,
            "message",
        );
        await flush();
        expect((await call).emoChanged).toBe(false);
        expect(get(CharEmotion)).toEqual({});
    });

    it("applies none from an answer older than a Re-render of its message", async () => {
        const ref = newChat();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const base = emotional("old", "key-old");
        state.handler = async (path, body) => {
            await gate;
            return base(path, body);
        };
        const old = serverProcessScript(char(ref.chaId), "o", "editdisplay", 0, {}, captureTransform(0)!, "message");
        await flush();
        rerenderMessage(ref, "m0");
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(await old).toEqual({ data: "o", emoChanged: false });
        expect(get(CharEmotion)).toEqual({});
    });
});

// A restore during a send (the restore-notice fix after Phase 6 slice 2): a transform the server
// refuses with a 412 EpochMismatch answers its targets raw and shows no failure toast, on either
// call and across a batch's chunks, since the terminal restore notice tells the user. Any other
// failure still toasts.
describe("a request a restore refused (412 EpochMismatch)", () => {
    const refused: Reply = { status: 412, body: { error: "EpochMismatch", epoch: "epoch-2" } };

    it("answers every target raw on the first call, across the batch's chunks, with no toast", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = () => refused;
        const calls = Array.from({ length: 65 }, (_, i) =>
            serverProcessScript(char(ref.chaId), `r${i}`, "editdisplay", 0, {}, captured, "message"),
        );
        await flush();
        const answers = await Promise.all(calls);
        expect(answers).toEqual(Array.from({ length: 65 }, (_, i) => ({ data: `r${i}`, emoChanged: false })));
        expect(transformPosts()).toHaveLength(2);
        expect(state.epochs).toEqual(["epoch-2", "epoch-2"]);
        expect(state.toasts).toEqual([]);
    });

    it("answers raw with no toast when the second call (after the plugin handlers) is refused", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.hooks.editdisplay.add((text) => `${text}+h`);
        state.handler = (path, body) => (path === "/api/transform/continue" ? refused : defaultHandler(path, body));
        const a = serverProcessScript(char(ref.chaId), "A", "editdisplay", 0, {}, captured, "message");
        const b = serverProcessScript(char(ref.chaId), "B", "editdisplay", 2, {}, captured, "text");
        await flush();
        expect(await a).toEqual({ data: "A", emoChanged: false });
        expect(await b).toEqual({ data: "B", emoChanged: false });
        expect(continuePosts()).toHaveLength(1);
        expect(state.epochs).toEqual(["epoch-2"]);
        expect(state.toasts).toEqual([]);
    });

    it("still toasts an ordinary failure of another batch sent alongside a refused one", async () => {
        const ref = newChat();
        const captured = captureTransform(0)!;
        state.handler = (_path, body) =>
            body.mode === "editdisplay" ? refused : { status: 500, body: { error: "Boom" } };
        const refusedCall = serverProcessScript(char(ref.chaId), "D", "editdisplay", 0, {}, captured, "message");
        const failedCall = serverProcessScript(char(ref.chaId), "P", "editprocess", 0, {}, captured, "message");
        await flush();
        expect((await refusedCall).data).toBe("D");
        expect((await failedCall).data).toBe("P");
        expect(transformPosts()).toHaveLength(2);
        expect(state.toasts).toEqual(["Render failed: Boom"]);
    });

    it("still toasts a later ordinary failure once a refused batch is done", async () => {
        const ref = newChat();
        state.handler = () => refused;
        const first = serverProcessScript(char(ref.chaId), "X", "editdisplay", 0, {}, captureTransform(0)!, "message");
        await flush();
        expect((await first).data).toBe("X");
        state.handler = () => ({ status: 503, body: { error: "Unavailable" } });
        const second = serverProcessScript(char(ref.chaId), "Y", "editdisplay", 0, {}, captureTransform(0)!, "message");
        await flush();
        expect((await second).data).toBe("Y");
        expect(state.toasts).toEqual(["Render failed: Unavailable"]);
    });
});
