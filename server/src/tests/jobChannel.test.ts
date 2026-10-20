// @vitest-environment node
import type http from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    CallbackResult,
    GenerationChannelEvent,
    GenerationEvent,
    GenerationHooks,
    HydrationReceipt,
    QuestionResult,
} from "../../../shared/jobs.ts";
import { MAX_PROVIDER_TEXT_CHARS, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import {
    CALLBACK_TIMEOUT_MS,
    type ChannelHub,
    createChannelHub,
    isBarrierFailure,
    parseGenerationHooks,
    QUESTION_TIMEOUT_MS,
} from "../jobs/channel.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, sleep, waitFor } from "./testSupport.ts";

// Phase 5 slice 6, the server side of the job channel. First the hub in isolation
// (`server/src/jobs/channel.ts`) over a recording transport with an injected clock: the hook
// list validation, notices, the request lifecycle (FIFO per client, nesting at most two deep,
// one absolute deadline from enqueue that the clock decides, the hydration receipts of a
// callback, answers bound to the outstanding request, delivery and replay, close). Then the
// registry wired to it (`generationJobs.ts`) on a real listening server with a fake runner: the
// 400 for a malformed list, a callback requested before the owner attaches, a reconnect with a
// pending question, answers only from the current socket, the hydration before a callback, and
// the abort or end of a job with a request pending.

const targets = { chatRef: { chaId: "c", chatId: "k" }, presetId: "p", modelPresetId: "m", personaId: "u" };
const receipt: HydrationReceipt = { kind: "chats", id: "k", characterId: "c", revision: "e:1:1" };
const validHooks: GenerationHooks = {
    replacers: { beforeRequest: true, afterRequest: false },
    scripts: ["editoutput", "editinput"],
    interceptors: true,
    chatOutput: false,
    providers: [
        {
            name: "prov",
            model: {
                id: "pluginmodel:::prov",
                name: "prov",
                shortName: "prov",
                fullName: "prov",
                internalID: "pluginmodel:::prov",
                provider: 0,
                format: 0,
                flags: [1, 2],
                parameters: ["temperature"],
                tokenizer: 0,
            },
        },
    ],
    mcpTools: ["plugin:tool", "plugin:tool"],
};

afterEach(() => {
    vi.useRealTimers();
});

describe("parseGenerationHooks", () => {
    it("takes a missing list as none, deduplicates, deep-copies the provider descriptors, and refuses malformed lists", () => {
        expect(parseGenerationHooks(undefined)).toEqual(NO_GENERATION_HOOKS);
        expect(parseGenerationHooks(undefined)).not.toBe(NO_GENERATION_HOOKS);
        const parsed = parseGenerationHooks(validHooks) as GenerationHooks;
        expect(parsed).toEqual({ ...validHooks, mcpTools: ["plugin:tool"] });
        // A copy: the client's descriptor is frozen at creation.
        validHooks.providers[0].model.flags.push(9);
        expect(parsed.providers[0].model.flags).toEqual([1, 2]);
        validHooks.providers[0].model.flags.pop();
        expect(parseGenerationHooks({ ...validHooks, scripts: ["editoutput", "editoutput"] })).toMatchObject({
            scripts: ["editoutput"],
        });
        for (const [bad, message] of [
            [null, /must be an object/],
            ["x", /must be an object/],
            [[], /must be an object/],
            [{ ...validHooks, replacers: { beforeRequest: true } }, /replacers/],
            [{ ...validHooks, scripts: "editoutput" }, /scripts/],
            [{ ...validHooks, scripts: ["dance"] }, /scripts/],
            [{ ...validHooks, interceptors: 1 }, /interceptors/],
            [{ ...validHooks, chatOutput: "yes" }, /chatOutput/],
            [{ ...validHooks, providers: [{ name: "x", model: {} }] }, /providers/],
            [{ ...validHooks, providers: [{ name: "", model: validHooks.providers[0].model }] }, /providers/],
            [
                {
                    ...validHooks,
                    providers: [{ name: "x", model: { ...validHooks.providers[0].model, flags: ["a"] } }],
                },
                /providers/,
            ],
            [{ ...validHooks, mcpTools: [1] }, /mcpTools/],
        ] as [unknown, RegExp][]) {
            const result = parseGenerationHooks(bad);
            expect(typeof result, JSON.stringify(bad)).toBe("string");
            expect(result).toMatch(message);
        }
    });

    it("isBarrierFailure reads the failure source, never the text", () => {
        expect(isBarrierFailure({ outcome: "failed", failure: "barrier", error: "x" })).toBe(true);
        expect(isBarrierFailure({ outcome: "failed", failure: "hook", error: "barrier failed" })).toBe(false);
        expect(isBarrierFailure({ outcome: "failed", failure: "protocol", error: "x" })).toBe(false);
        expect(isBarrierFailure({ outcome: "timedOut" })).toBe(false);
        expect(isBarrierFailure({ outcome: "answered", value: { failure: "barrier" } })).toBe(false);
    });
});

type Sent = GenerationChannelEvent & { job: string };
type Link = ReturnType<ChannelHub["open"]>;

/**
 * The hub over recording transports with an injected clock. Timers are faked; `clock.value`
 * advances the channel's clock without them (`tick` advances both). `clock.reads` answers the
 * next clock reads first (an advance between two checks).
 */
function harness() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = { value: 1_000, reads: [] as number[] };
    const hub = createChannelHub({ now: () => clock.reads.shift() ?? clock.value });
    const sent: Sent[] = [];
    const hydrations: string[] = [];
    const attached = { value: true };
    const delivering = { value: true };
    const open = (jobId: string, options: { clientId?: string; hooks?: Partial<GenerationHooks> } = {}): Link =>
        hub.open({
            jobId,
            clientId: options.clientId ?? "tab",
            epoch: "e",
            targets,
            hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"], ...options.hooks },
            send: (event) => {
                sent.push({ ...event, job: jobId });
                return delivering.value;
            },
            hydrate: () => {
                hydrations.push(jobId);
                return [receipt];
            },
            ownerAttached: () => attached.value,
        });
    const ofType = <T extends Sent["type"]>(type: T) =>
        sent.filter((event) => event.type === type) as (Sent & {
            type: T;
        })[];
    const last = <T extends Sent["type"]>(type: T) => ofType(type).at(-1)!;
    const answer = (link: Link, id: string, value: unknown = "ok") =>
        link.handleMessage({ type: "answer", id, outcome: "answered", value });
    /** Advances the clock and the timers together. */
    const tick = async (ms: number) => {
        clock.value += ms;
        await vi.advanceTimersByTimeAsync(ms);
    };
    /** Resolves with the settled result, or "pending" after the microtasks ran. */
    const state = <T>(promise: Promise<T>) =>
        Promise.race([promise, new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]);
    return { clock, hub, sent, hydrations, attached, delivering, open, ofType, last, answer, tick, state };
}

describe("the hub: notices and questions", () => {
    it("sends a notice at once, even while a question is outstanding, and drops one after close", () => {
        const h = harness();
        const link = h.open("a");
        link.channel.notice({ kind: "alertToast", payload: { message: "hi" } });
        void link.channel.ask({ kind: "alertConfirm", payload: { message: "q" } });
        link.channel.notice({ kind: "progress", payload: { open: true, miniMsg: "", msg: "m", subMsg: "" } });
        expect(h.sent.map((event) => event.type)).toEqual(["notice", "question", "notice"]);
        expect(h.sent[0]).toMatchObject({ type: "notice", epoch: "e", kind: "alertToast", payload: { message: "hi" } });
        link.close("done");
        link.channel.notice({ kind: "alertToast", payload: { message: "late" } });
        expect(h.ofType("notice")).toHaveLength(2);
    });

    it("sends a question with its id and deadline, queues a second one until the first settles, and binds the answer to the outstanding id", async () => {
        const h = harness();
        const link = h.open("a");
        const first = link.channel.ask({ kind: "alertInput", payload: { message: "one", defaultValue: "d" } });
        const second = link.channel.ask({ kind: "alertSelect", payload: { options: ["x", "y"] } });
        expect(h.ofType("question")).toHaveLength(1);
        const q1 = h.last("question");
        expect(q1).toMatchObject({
            epoch: "e",
            kind: "alertInput",
            payload: { message: "one", defaultValue: "d" },
            deadline: h.clock.value + QUESTION_TIMEOUT_MS,
        });
        expect(q1.replay).toBeUndefined();
        expect(await h.state(first)).toBe("pending");
        // Malformed or misaddressed answers are ignored: an unknown id, a wrong type, no `value`,
        // a callback-only outcome, a bad `failed` shape, and an answer for the queued question.
        link.handleMessage({ type: "answer", id: "nope", outcome: "answered", value: 1 });
        link.handleMessage({ type: "chatter", id: q1.id });
        link.handleMessage({ type: "answer", id: q1.id, outcome: "answered" });
        link.handleMessage({ type: "answer", id: q1.id, outcome: "failed", failure: "hook", error: "x" });
        link.handleMessage({ type: "answer", id: q1.id, outcome: "timedOut" });
        link.handleMessage("answer");
        expect(await h.state(first)).toBe("pending");
        expect(h.ofType("question")).toHaveLength(1);
        h.answer(link, q1.id, "typed");
        expect(await first).toEqual({ outcome: "answered", value: "typed" });
        // No `cancel` for an answered request; the second question is sent now.
        expect(h.ofType("cancel")).toHaveLength(0);
        const q2 = h.last("question");
        expect(q2).toMatchObject({ kind: "alertSelect", payload: { options: ["x", "y"] } });
        expect(q2.id).not.toBe(q1.id);
        // A late answer for the settled one changes nothing; `cancelled` is a valid question outcome.
        h.answer(link, q1.id, "again");
        link.handleMessage({ type: "answer", id: q2.id, outcome: "cancelled" });
        expect(await second).toEqual({ outcome: "cancelled" });
        expect(await first).toEqual({ outcome: "answered", value: "typed" });
    });

    it("keeps the notices of an owner that has not attached yet within a UTF-8 byte budget, sends them on the first attach in order with the requests made meanwhile, and buffers nothing after it", async () => {
        const h = harness();
        h.attached.value = false;
        const link = h.open("a");
        // 400k UTF-16 units but 1.2 MB of UTF-8: over the budget, dropped; the small ones are kept.
        link.channel.notice({ kind: "alertNormal", payload: { message: "가".repeat(400_000) } });
        link.channel.notice({ kind: "alertNormal", payload: { message: "first" } });
        const question = link.channel.ask({ kind: "alertInput", payload: { message: "q" } });
        link.channel.notice({ kind: "alertNormal", payload: { message: "second" } });
        // A request is dispatched to the transport as before; the notices wait for the owner.
        expect(h.sent.map((event) => event.type)).toEqual(["question"]);
        h.attached.value = true;
        link.handleAttach();
        expect(
            h.sent
                .slice(1)
                .map((event) =>
                    event.type === "notice" ? (event.payload as { message: string }).message : event.type,
                ),
        ).toEqual(["first", "question", "second"]);
        expect(h.last("question").replay).toBe(true);
        expect(h.ofType("notice").some((event) => (event.payload as { message: string }).message.length > 1000)).toBe(
            false,
        );
        // After the first attach a notice goes to the transport whether or not an owner is there.
        h.attached.value = false;
        link.channel.notice({ kind: "alertNormal", payload: { message: "third" } });
        expect(h.last("notice").payload).toEqual({ message: "third" });
        expect(link.takeEarly()).toEqual([]);
        h.answer(link, h.last("question").id, "a");
        expect(await question).toEqual({ outcome: "answered", value: "a" });

        // A job that ended before any attach: the registry takes the kept notices for its terminal.
        const ended = h.open("b");
        ended.channel.notice({ kind: "alertNormal", payload: { message: "only" } });
        ended.close("done");
        expect(ended.takeEarly()).toMatchObject([
            { type: "notice", kind: "alertNormal", payload: { message: "only" } },
        ]);
        expect(ended.takeEarly()).toEqual([]);
    });

    it("refuses an unsendable payload before it takes a slot", () => {
        const h = harness();
        const link = h.open("a");
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => link.channel.ask({ kind: "alertInput", payload: cyclic as never })).toThrow();
        expect(() => link.channel.callback("editoutput", cyclic as never)).toThrow();
        expect(h.sent).toEqual([]);
        void link.channel.ask({ kind: "alertConfirm", payload: { message: "ok" } });
        expect(h.ofType("question")).toHaveLength(1);
    });
});

describe("the hub: deadlines", () => {
    it("times out with an owner attached (cancel sent) and reports a disconnect without one", async () => {
        const h = harness();
        const link = h.open("a");
        const timed = link.channel.ask({ kind: "alertConfirm", payload: { message: "q" } }, { timeoutMs: 500 });
        const id = h.last("question").id;
        await h.tick(499);
        expect(await h.state(timed)).toBe("pending");
        await h.tick(1);
        expect(await timed).toEqual({ outcome: "timedOut", error: expect.any(String) });
        expect(h.last("cancel")).toMatchObject({ type: "cancel", epoch: "e", id });
        h.attached.value = false;
        const detached = link.channel.callback("editoutput", { text: "x" }, { timeoutMs: 100 });
        await h.tick(100);
        expect(await detached).toMatchObject({ outcome: "disconnected" });
        // A callback's default is 60 s; a question's 120 s.
        const slow = link.channel.callback("editoutput", { text: "y" });
        expect(h.last("callback").deadline).toBe(h.clock.value + CALLBACK_TIMEOUT_MS);
        link.close("end");
        await slow;
    });

    it("lets the clock decide, not the timer: an answer after the deadline is refused and a reattach settles it", async () => {
        const h = harness();
        const link = h.open("a");
        const asked = link.channel.ask({ kind: "alertConfirm", payload: { message: "q" } }, { timeoutMs: 500 });
        const id = h.last("question").id;
        // The clock passes the deadline while the timer has not fired.
        h.clock.value += 500;
        h.answer(link, id, true);
        expect(await asked).toMatchObject({ outcome: "timedOut" });
        expect(h.last("cancel").id).toBe(id);
        // An early timer never settles a request before its deadline.
        const early = link.channel.ask({ kind: "alertConfirm", payload: { message: "q2" } }, { timeoutMs: 500 });
        await vi.advanceTimersByTimeAsync(500);
        expect(await h.state(early)).toBe("pending");
        const id2 = h.last("question").id;
        h.clock.value += 500;
        link.handleAttach();
        expect(await early).toMatchObject({ outcome: "timedOut" });
        expect(h.ofType("question").filter((event) => event.id === id2)).toHaveLength(1);
    });

    it("expires queued roots in the queue (never hydrated or sent), then dispatches the live one once and reuses the lane", async () => {
        const h = harness();
        const a = h.open("a");
        const b = h.open("b");
        const blocking = a.channel.callback("editoutput", { text: "first" });
        const blockingId = h.last("callback").id;
        const expired = Array.from({ length: 20 }, () =>
            b.channel.callback("editoutput", { text: "expired" }, { timeoutMs: 10 }),
        );
        const live = b.channel.callback("editoutput", { text: "live" });
        h.clock.value += 10;
        h.answer(a, blockingId);
        expect(await blocking).toEqual({ outcome: "answered", value: "ok" });
        expect((await Promise.all(expired)).every((result) => result.outcome === "timedOut")).toBe(true);
        expect(h.hydrations).toEqual(["a", "b"]);
        expect(h.ofType("callback").map((event) => (event.payload as { text: string }).text)).toEqual([
            "first",
            "live",
        ]);
        // No `cancel` for a request the client never got.
        expect(h.ofType("cancel")).toHaveLength(0);
        h.answer(b, h.last("callback").id, "L");
        expect(await live).toEqual({ outcome: "answered", value: "L" });
        const later = a.channel.callback("editoutput", { text: "later" });
        h.answer(a, h.last("callback").id, "later");
        expect(await later).toEqual({ outcome: "answered", value: "later" });
    });

    it("expires a request whose deadline passes between the queue's check and its dispatch, and promotes the next root exactly once", async () => {
        const h = harness();
        const a = h.open("a");
        const b = h.open("b");
        const c = h.open("c");
        const blocking = a.channel.callback("editoutput", { text: "first" });
        const blockingId = h.last("callback").id;
        const borderline = b.channel.callback("editoutput", { text: "borderline" }, { timeoutMs: 10 });
        const next = c.channel.callback("editoutput", { text: "next" });
        // The answer's own check and the queue's check read the old time; the dispatch reads the new one.
        h.clock.value += 10;
        h.clock.reads = [1_000, 1_000, 1_010];
        h.answer(a, blockingId);
        expect(await blocking).toMatchObject({ outcome: "answered" });
        expect(await borderline).toMatchObject({ outcome: "timedOut" });
        expect(h.hydrations).toEqual(["a", "c"]);
        expect(h.ofType("callback").map((event) => event.job)).toEqual(["a", "c"]);
        h.answer(c, h.last("callback").id);
        expect(await next).toMatchObject({ outcome: "answered" });
    });
});

describe("the hub: callbacks and nesting", () => {
    it("refuses a callback the hook list lacks without sending it, by name, side, mode, provider name, and MCP identifier", async () => {
        const h = harness();
        const link = h.open("a", {
            hooks: {
                replacers: { beforeRequest: true, afterRequest: false },
                scripts: ["editinput"],
                interceptors: false,
                chatOutput: false,
                providers: [validHooks.providers[0]],
                mcpTools: ["plugin:tool"],
            },
        });
        const refusals = await Promise.all([
            link.channel.callback("replacerafterRequest", { text: "t", model: "m" }),
            link.channel.callback("editoutput", { text: "t" }),
            link.channel.callback("bodyIntercepter", { body: {}, type: "x" }),
            link.channel.callback("chatOutput", { messageId: "m", speakerId: "c" }),
            link.channel.callback("provider", { name: "other", argument: {} }),
            link.channel.callback("mcpTool", { identifier: "plugin:other", tool: "t", args: {} }),
        ]);
        expect(refusals.every((result) => result.outcome === "refused")).toBe(true);
        expect(h.sent).toEqual([]);
        expect(h.hydrations).toEqual([]);
        const allowed: Promise<CallbackResult>[] = [];
        allowed.push(link.channel.callback("replacerbeforeRequest", { messages: [], model: "m" }));
        h.answer(link, h.last("callback").id);
        allowed.push(link.channel.callback("editinput", { text: "t" }));
        h.answer(link, h.last("callback").id);
        allowed.push(link.channel.callback("provider", { name: "prov", argument: {} }));
        h.answer(link, h.last("callback").id);
        allowed.push(link.channel.callback("mcpTool", { identifier: "plugin:tool", tool: "t", args: {} }));
        h.answer(link, h.last("callback").id);
        // A client capability, always allowed.
        allowed.push(link.channel.callback("generateImage", { prompt: "p", negative: "", characterId: "c" }));
        h.answer(link, h.last("callback").id);
        allowed.push(link.channel.callback("selectedChat", { characterId: "c" }));
        h.answer(link, h.last("callback").id);
        expect((await Promise.all(allowed)).every((result) => result.outcome === "answered")).toBe(true);
        expect(h.ofType("callback").map((event) => event.name)).toEqual([
            "replacerbeforeRequest",
            "editinput",
            "provider",
            "mcpTool",
            "generateImage",
            "selectedChat",
        ]);
    });

    it("hydrates right before sending a callback, which carries the receipts, the targets, the job, and its deadline", () => {
        const h = harness();
        const link = h.open("a");
        void link.channel.callback("editoutput", { text: "t" }, { timeoutMs: 5_000 });
        expect(h.hydrations).toEqual(["a"]);
        expect(h.last("callback")).toMatchObject({
            type: "callback",
            epoch: "e",
            jobId: "a",
            name: "editoutput",
            targets,
            revisions: [receipt],
            payload: { text: "t" },
            deadline: h.clock.value + 5_000,
        });
        expect(h.last("callback").parentId).toBeUndefined();
        expect(h.last("callback").replay).toBeUndefined();
    });

    it("runs a child inside the outstanding callback at once with a deadline capped by its parent's, refuses any other parent or a third level, and aborts the child when the parent settles", async () => {
        const h = harness();
        const a = h.open("a");
        const b = h.open("b");
        const parent = a.channel.callback("editoutput", { text: "parent" }, { timeoutMs: 1_000 });
        const parentId = h.last("callback").id;
        const waiting = b.channel.callback("editoutput", { text: "root of b" });
        expect(h.ofType("callback")).toHaveLength(1);
        // A wrong parent, a question as a parent, and a question naming a parent are refused.
        expect(await a.channel.callback("editoutput", { text: "x" }, { parentId: "nope" })).toMatchObject({
            outcome: "refused",
        });
        // The child of another job (an aux request's callback) runs inside the parent, capped.
        const child = b.channel.callback("editoutput", { text: "child" }, { parentId, timeoutMs: 5_000 });
        const childEvent = h.last("callback");
        expect(childEvent).toMatchObject({ job: "b", parentId, deadline: h.clock.value + 1_000 });
        // A third level is refused, and so is a second child beside the first.
        expect(
            await a.channel.callback("editoutput", { text: "grandchild" }, { parentId: childEvent.id }),
        ).toMatchObject({ outcome: "refused" });
        expect(await a.channel.callback("editoutput", { text: "sibling" }, { parentId })).toMatchObject({
            outcome: "refused",
        });
        expect(await h.state(waiting)).toBe("pending");
        h.answer(b, childEvent.id, "C");
        expect(await child).toEqual({ outcome: "answered", value: "C" });
        // The parent still holds the lane: b's root waits.
        expect(await h.state(waiting)).toBe("pending");
        // A second child after the first settled is fine; the parent's end aborts it with a cancel.
        const orphan = b.channel.callback("editoutput", { text: "orphan" }, { parentId });
        const orphanId = h.last("callback").id;
        h.answer(a, parentId, "P");
        expect(await parent).toEqual({ outcome: "answered", value: "P" });
        expect(await orphan).toMatchObject({ outcome: "aborted" });
        expect(h.ofType("cancel").map((event) => event.id)).toEqual([orphanId]);
        // Then the next root of the lane.
        expect(h.last("callback")).toMatchObject({ job: "b", payload: { text: "root of b" } });
        h.answer(b, h.last("callback").id);
        expect(await waiting).toMatchObject({ outcome: "answered" });
    });

    it("settles an overdue parent before admitting a child: the child is refused, the next root runs once, and a zero-timeout child neither hydrates nor sends", async () => {
        const h = harness();
        const a = h.open("a");
        const b = h.open("b");
        const parent = a.channel.callback("editoutput", { text: "parent" }, { timeoutMs: 10 });
        const parentId = h.last("callback").id;
        const next = b.channel.callback("editoutput", { text: "next" });
        h.clock.value += 20;
        const late = a.channel.callback("editoutput", { text: "late child" }, { parentId });
        expect(await parent).toMatchObject({ outcome: "timedOut" });
        expect(await late).toMatchObject({ outcome: "refused" });
        expect(h.hydrations).toEqual(["a", "b"]);
        expect(h.ofType("callback").map((event) => event.job)).toEqual(["a", "b"]);
        const nextId = h.last("callback").id;
        // The successor cannot be a parent for the old id, and a zero-timeout child of it expires
        // before dispatch, leaving the parent's lane as it was.
        expect(await a.channel.callback("editoutput", { text: "x" }, { parentId })).toMatchObject({
            outcome: "refused",
        });
        const zero = a.channel.callback("editoutput", { text: "zero" }, { parentId: nextId, timeoutMs: 0 });
        expect(await zero).toMatchObject({ outcome: "timedOut" });
        expect(h.hydrations).toEqual(["a", "b"]);
        expect(h.ofType("callback")).toHaveLength(2);
        h.answer(b, nextId);
        expect(await next).toMatchObject({ outcome: "answered" });
    });

    it("serializes roots per client across jobs in FIFO order, keeps clients independent, and caps the queue", async () => {
        const h = harness();
        const a = h.open("a");
        const b = h.open("b");
        const other = h.open("o", { clientId: "other" });
        const results: Promise<QuestionResult | CallbackResult>[] = [
            a.channel.ask({ kind: "alertConfirm", payload: { message: "1" } }),
            b.channel.callback("editoutput", { text: "2" }),
            a.channel.ask({ kind: "alertConfirm", payload: { message: "3" } }),
            other.channel.ask({ kind: "alertConfirm", payload: { message: "o" } }),
        ];
        expect(h.sent.map((event) => `${event.job}:${event.type}`)).toEqual(["a:question", "o:question"]);
        h.answer(a, h.ofType("question")[0].id, 1);
        expect(h.last("callback")).toMatchObject({ job: "b" });
        h.answer(b, h.last("callback").id, 2);
        expect(h.last("question")).toMatchObject({ job: "a", payload: { message: "3" } });
        h.answer(a, h.last("question").id, 3);
        h.answer(other, h.ofType("question")[1].id, "o");
        expect((await Promise.all(results)).map((result) => (result as { value: unknown }).value)).toEqual([
            1,
            2,
            3,
            "o",
        ]);
        const blocking = a.channel.ask({ kind: "alertConfirm", payload: { message: "hold" } });
        const queued = Array.from({ length: 256 }, () =>
            a.channel.ask({ kind: "alertConfirm", payload: { message: "q" } }),
        );
        expect(await a.channel.ask({ kind: "alertConfirm", payload: { message: "one too many" } })).toMatchObject({
            outcome: "refused",
        });
        a.close("end");
        expect((await Promise.all([blocking, ...queued])).every((result) => result.outcome === "aborted")).toBe(true);
    });
});

describe("the hub: delivery, replay, and close", () => {
    it("marks a request as a replay only after an owner socket took it: a first delivery on attach is not one", () => {
        const h = harness();
        h.delivering.value = false;
        const link = h.open("a");
        void link.channel.callback("editoutput", { text: "early" });
        expect(h.last("callback").replay).toBeUndefined();
        // Still nobody: the attach sends it as a first delivery again.
        link.handleAttach();
        expect(h.ofType("callback")).toHaveLength(2);
        expect(h.last("callback").replay).toBeUndefined();
        h.delivering.value = true;
        link.handleAttach();
        expect(h.last("callback").replay).toBeUndefined();
        // Taken once: from now on it is a replay, with the same id and deadline, hydrated again.
        link.handleAttach();
        const events = h.ofType("callback");
        expect(events).toHaveLength(4);
        expect(events[3]).toMatchObject({ id: events[0].id, deadline: events[0].deadline, replay: true });
        expect(h.hydrations).toHaveLength(4);
        // A queued request is not re-sent, a settled one neither.
        void link.channel.ask({ kind: "alertConfirm", payload: { message: "queued" } });
        link.handleAttach();
        expect(h.ofType("question")).toHaveLength(0);
        h.answer(link, events[0].id);
        link.handleAttach();
        expect(h.ofType("question")).toHaveLength(2);
        expect(h.ofType("question")[1]).toMatchObject({ id: h.ofType("question")[0].id, replay: true });
    });

    it("settles a request whose send throws as aborted without a cancel, and keeps the lane usable", async () => {
        const h = harness();
        let fail = true;
        const link = h.hub.open({
            jobId: "a",
            clientId: "tab",
            epoch: "e",
            targets,
            hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"] },
            send: (event) => {
                if (fail) {
                    throw new Error("socket gone");
                }
                h.sent.push({ ...event, job: "a" });
                return true;
            },
            hydrate: () => [],
            ownerAttached: () => true,
        });
        expect(await link.channel.callback("editoutput", { text: "x" })).toMatchObject({
            outcome: "aborted",
            error: expect.stringContaining("socket gone"),
        });
        fail = false;
        const next = link.channel.callback("editoutput", { text: "y" });
        expect(h.ofType("callback")).toHaveLength(1);
        expect(h.ofType("cancel")).toHaveLength(0);
        h.answer(link, h.last("callback").id);
        expect(await next).toMatchObject({ outcome: "answered" });
    });

    it("close settles every request aborted (queued ones silently, outstanding ones with a cancel), is idempotent, refuses later requests, and lets another job's root run", async () => {
        const h = harness();
        const a = h.open("a");
        const b = h.open("b");
        const outstanding = a.channel.callback("editoutput", { text: "out" });
        const outstandingId = h.last("callback").id;
        const child = b.channel.callback("editoutput", { text: "child" }, { parentId: outstandingId });
        const childId = h.last("callback").id;
        const queued = a.channel.ask({ kind: "alertConfirm", payload: { message: "queued" } });
        const next = b.channel.callback("editoutput", { text: "b root" });
        a.close("The job has ended");
        a.close("again");
        expect(await outstanding).toEqual({ outcome: "aborted", error: "The job has ended" });
        expect(await queued).toEqual({ outcome: "aborted", error: "The job has ended" });
        // The child of another job dies with its parent, through its own channel.
        expect(await child).toMatchObject({ outcome: "aborted" });
        expect(h.ofType("cancel").map((event) => [event.job, event.id])).toEqual([
            ["b", childId],
            ["a", outstandingId],
        ]);
        expect(await a.channel.ask({ kind: "alertConfirm", payload: { message: "late" } })).toMatchObject({
            outcome: "aborted",
        });
        expect(await a.channel.callback("editoutput", { text: "late" })).toMatchObject({ outcome: "aborted" });
        expect(h.last("callback")).toMatchObject({ job: "b", payload: { text: "b root" } });
        h.answer(b, h.last("callback").id);
        expect(await next).toMatchObject({ outcome: "answered" });
        // Timers are gone: nothing fires later.
        await h.tick(QUESTION_TIMEOUT_MS + 1);
        expect(h.ofType("cancel")).toHaveLength(2);
    });
});

describe("the registry over a real socket", () => {
    type Step = (job: RunningJob) => void | Promise<void>;
    let server: ReturnType<typeof createTestServer> | undefined;
    let node: http.Server | undefined;
    let base = "";
    let epoch = "";
    let signer: Awaited<ReturnType<typeof createSigner>>;
    /** The chat's binding (`docs/plan/chat-binding.md`): the default records' ids, which every job names. */
    let bound = { presetId: "", modelPresetId: "", personaId: "" };
    let steps: Step[] = [];
    let wake: (() => void) | null = null;

    const runner = async (job: RunningJob) => {
        job.signal.addEventListener("abort", () => wake?.());
        for (;;) {
            if (steps.length === 0) {
                if (job.signal.aborted) {
                    return;
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
                continue;
            }
            const step = steps.shift()!;
            if ((await step(job)) === ("end" as never)) {
                if (!job.signal.aborted) {
                    job.emit({ type: "done", revision: null });
                }
                return;
            }
        }
    };
    const step = (fn: Step) => {
        steps.push(fn);
        wake?.();
        wake = null;
    };

    afterEach(async () => {
        steps = [];
        wake = null;
        await server?.close();
        server = undefined;
        if (node) {
            node.closeAllConnections();
            await new Promise((resolve) => node?.close(resolve));
            node = undefined;
        }
    });

    async function listen() {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        server = createTestServer({ password: "pw", generationRunner: runner });
        const started = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        node = started;
        await new Promise<void>((resolve) => started.once("listening", () => resolve()));
        allowListenerOrigin(started);
        server.context.attachWebSocket(started);
        base = `http://127.0.0.1:${(started.address() as { port: number }).port}`;
        signer = await createSigner();
        await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
        epoch = ((await (await request("/api/resources/ui")).json()) as { epoch: string }).epoch;
        const firstId = async (kind: string) =>
            ((await (await request(`/api/resources/${kind}/main`)).json()) as { data: { id: string }[] }).data[0].id;
        bound = {
            presetId: await firstId("presets"),
            modelPresetId: await firstId("modelPresets"),
            personaId: await firstId("personas"),
        };
        const seeded = await request(
            "/api/resources/batch",
            json({
                ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    name: "K",
                                    modelPresetId: bound.modelPresetId,
                                    promptPresetId: bound.presetId,
                                    bindedPersona: bound.personaId,
                                    message: [{ role: "user", data: "hi", chatId: "u" }],
                                },
                            },
                        ],
                    },
                ],
            }),
        );
        expect(seeded.status).toBe(200);
    }

    async function request(url: string, init: RequestInit = {}) {
        return fetch(`${base}${url}`, {
            ...init,
            headers: {
                "risu-auth": await signer.jwt(),
                "x-resource-epoch": epoch,
                ...((init.headers as Record<string, string>) ?? {}),
            },
        });
    }
    const chatRevision = async () =>
        (
            (await (await request("/api/resources/read", json({ chats: [{ characterId: "c", id: "k" }] }))).json()) as {
                chats: { revision: string }[];
            }
        ).chats[0].revision;
    const create = async (hooks: unknown = { ...NO_GENERATION_HOOKS, scripts: ["editoutput"] }) => {
        const res = await request(
            "/api/generations",
            json({
                kind: "command",
                // A command job carries what it runs (slice 8a); the fake runner here never reads it.
                command: { type: "button", data: "" },
                clientId: "tab",
                ...(hooks === undefined ? {} : { hooks }),
                context: {
                    characterId: "c",
                    chatId: "k",
                    ...bound,
                    mode: "normal",
                    input: "",
                    chatRevision: await chatRevision(),
                },
            }),
        );
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    type Client = {
        events: GenerationEvent[];
        send(message: unknown): void;
        close(): void;
        /** The next event of `type` not taken yet. */
        next<T extends GenerationEvent["type"]>(type: T): Promise<Extract<GenerationEvent, { type: T }>>;
    };
    async function connect(jobId: string, attach = Date.now()): Promise<Client> {
        const ws = new WebSocket(
            `${base.replace("http", "ws")}/api/generations/${jobId}/ws?risu-auth=${encodeURIComponent(
                await signer.jwt(),
            )}&clientId=tab&attach=${attach}`,
        );
        const events: GenerationEvent[] = [];
        const taken = new Set<GenerationEvent>();
        ws.onmessage = (message) => {
            const event = JSON.parse(String(message.data)) as GenerationEvent;
            if (event.type !== "ping") {
                events.push(event);
            }
        };
        ws.onerror = () => {};
        await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
        return {
            events,
            send: (message) => ws.send(JSON.stringify(message)),
            close: () => ws.close(),
            async next(type) {
                let found: GenerationEvent | undefined;
                try {
                    await waitFor(() => {
                        found = events.find((event) => event.type === type && !taken.has(event));
                        return found !== undefined;
                    });
                } catch {
                    throw new Error(`no ${type} event; seen: ${JSON.stringify(events)}`);
                }
                taken.add(found!);
                return found as never;
            },
        };
    }
    const types = (events: GenerationEvent[]) => events.map((event) => event.type);

    it("answers 400 for a malformed hook list and admits a job without one", async () => {
        await listen();
        expect(await create({ ...NO_GENERATION_HOOKS, scripts: "editoutput" })).toMatchObject({
            status: 400,
            body: { error: expect.stringContaining("hooks.scripts") },
        });
        expect(await create("x")).toMatchObject({ status: 400, body: { error: "hooks must be an object" } });
        step(() => "end" as never);
        expect((await create(undefined)).status).toBe(200);
    });

    it("delivers a callback requested before the owner attaches as a first delivery, hydrated right before it, and takes its answer", async () => {
        await listen();
        const outcome: { result?: CallbackResult; receipts?: HydrationReceipt[] } = {};
        step(async (job) => {
            outcome.receipts = job.emitRecords({ refs: [{ kind: "characters", id: "c" }] });
            outcome.result = await job.channel.callback("editoutput", { text: "early" });
            return "end" as never;
        });
        const { body } = await create();
        const jobId = body.jobId as string;
        await sleep(50);
        const owner = await connect(jobId);
        const callback = await owner.next("callback");
        expect(callback.replay).toBeUndefined();
        expect(callback).toMatchObject({ jobId, name: "editoutput", payload: { text: "early" } });
        // The attach snapshot (the job chat as a `chatPatch` while the job runs, and the character the
        // job sent), then the barrier's fresh hydration of both (the chat whole: the client's barrier
        // re-applies a remembered whole copy once its local work settled), then the callback carrying
        // their receipts.
        const index = owner.events.indexOf(callback);
        expect(types(owner.events.slice(0, index))).toEqual(["chatPatch", "resource", "resource", "resource"]);
        const hydrated = owner.events.slice(index - 2, index) as Extract<GenerationEvent, { type: "resource" }>[];
        expect(callback.revisions).toEqual(
            hydrated.map((event) => ({
                kind: event.kind,
                id: event.id,
                ...(event.characterId !== undefined ? { characterId: event.characterId } : {}),
                revision: event.revision,
            })),
        );
        expect(callback.revisions.map((entry) => entry.kind)).toEqual(["chats", "characters"]);
        expect(outcome.receipts).toEqual([{ kind: "characters", id: "c", revision: callback.revisions[1].revision }]);
        owner.send({ type: "answer", id: callback.id, outcome: "answered", value: "EARLY" });
        await owner.next("done");
        expect(outcome.result).toEqual({ outcome: "answered", value: "EARLY" });
        expect(types(owner.events).filter((type) => type === "cancel")).toEqual([]);
    });

    it("hands an aux request of a callback the job's targets as they are now, a presetChain pick included, as a detached copy (`docs/plan/chat-binding.md`)", async () => {
        await listen();
        const outcome: { result?: CallbackResult } = {};
        step(async (job) => {
            job.setCallbackPreset!("picked");
            outcome.result = await job.channel.callback("editoutput", { text: "x" });
            return "end" as never;
        });
        const { body } = await create();
        const jobId = body.jobId as string;
        const owner = await connect(jobId);
        const callback = await owner.next("callback");
        expect(callback.targets).toEqual({ chatRef: { chaId: "c", chatId: "k" }, ...bound, presetId: "picked" });
        const settled = vi.fn();
        const parent = server!.context.generationJobs.parentCallback(jobId, "tab", callback.id, settled)!;
        expect(parent).not.toBeNull();
        expect(parent.targets).toEqual({ chatRef: { chaId: "c", chatId: "k" }, ...bound, presetId: "picked" });
        parent.targets.presetId = "mutated";
        const again = server!.context.generationJobs.parentCallback(jobId, "tab", callback.id, () => {})!;
        expect(again.targets.presetId).toBe("picked");
        // Another client, an unknown callback: none.
        expect(server!.context.generationJobs.parentCallback(jobId, "other", callback.id, () => {})).toBeNull();
        expect(server!.context.generationJobs.parentCallback(jobId, "tab", "nope", () => {})).toBeNull();
        parent.unwatch();
        again.unwatch();
        owner.send({ type: "answer", id: callback.id, outcome: "answered", value: "X" });
        await owner.next("done");
        expect(outcome.result).toEqual({ outcome: "answered", value: "X" });
        expect(settled).not.toHaveBeenCalled();
    });

    it("re-sends a pending question on a reconnect as a replay, ignores the superseded socket's answer, and times out with a cancel", async () => {
        await listen();
        const outcome: { first?: QuestionResult; second?: QuestionResult } = {};
        step(async (job) => {
            outcome.first = await job.channel.ask({ kind: "alertConfirm", payload: { message: "again?" } });
            outcome.second = await job.channel.ask(
                { kind: "alertInput", payload: { message: "x" } },
                { timeoutMs: 300 },
            );
            return "end" as never;
        });
        const jobId = (await create()).body.jobId as string;
        const first = await connect(jobId, 1);
        const q1 = await first.next("question");
        const second = await connect(jobId, 2);
        const q2 = await second.next("question");
        expect(q2).toEqual({ ...q1, replay: true });
        first.send({ type: "answer", id: q1.id, outcome: "answered", value: false });
        await sleep(100);
        expect(outcome.first).toBeUndefined();
        second.send({ type: "answer", id: q1.id, outcome: "answered", value: true });
        await waitFor(() => outcome.first !== undefined);
        expect(outcome.first).toEqual({ outcome: "answered", value: true });
        const q3 = await second.next("question");
        const cancel = await second.next("cancel");
        expect(cancel.id).toBe(q3.id);
        await second.next("done");
        expect(outcome.second).toMatchObject({ outcome: "timedOut" });
        // The job chat on the attach and at the end goes as a `chatPatch` (the job's own chat events).
        expect(types(second.events)).toEqual(["chatPatch", "question", "question", "cancel", "chatPatch", "done"]);
    });

    it("reports a disconnect for a question nobody could answer", async () => {
        await listen();
        const outcome: { result?: QuestionResult } = {};
        step(async (job) => {
            outcome.result = await job.channel.ask(
                { kind: "alertConfirm", payload: { message: "?" } },
                { timeoutMs: 200 },
            );
            return "end" as never;
        });
        await create();
        await waitFor(() => outcome.result !== undefined, 2_000);
        expect(outcome.result).toMatchObject({ outcome: "disconnected" });
    });

    it("settles a pending request aborted with a cancel before the terminal, on DELETE and on a normal end", async () => {
        await listen();
        const outcome: { question?: QuestionResult; callback?: CallbackResult } = {};
        step(async (job) => {
            outcome.question = await job.channel.ask({ kind: "alertConfirm", payload: { message: "?" } });
        });
        const jobId = (await create()).body.jobId as string;
        const owner = await connect(jobId);
        const question = await owner.next("question");
        expect((await request(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" })).status).toBe(200);
        await owner.next("error");
        expect(outcome.question).toMatchObject({ outcome: "aborted" });
        expect(types(owner.events)).toEqual(["chatPatch", "question", "cancel", "chatPatch", "error"]);
        expect((owner.events[2] as { id: string }).id).toBe(question.id);

        // A runner that ends while its callback waits (once the owner has it): the callback is
        // aborted first.
        let release!: () => void;
        const delivered = new Promise<void>((resolve) => {
            release = resolve;
        });
        step(async (job) => {
            void job.channel.callback("editoutput", { text: "t" }).then((result) => {
                outcome.callback = result;
            });
            await delivered;
            return "end" as never;
        });
        const second = (await create()).body.jobId as string;
        const next = await connect(second);
        const callback = await next.next("callback");
        release();
        await next.next("done");
        expect(outcome.callback).toMatchObject({ outcome: "aborted" });
        // The attach's `chatPatch`, the barrier's whole chat before the callback, the terminal `chatPatch`.
        expect(types(next.events)).toEqual(["chatPatch", "resource", "callback", "cancel", "chatPatch", "done"]);
        expect((next.events[3] as { id: string }).id).toBe(callback.id);
    });
});

describe("the hub: provider chunks and the caller's signal (slice 11b)", () => {
    const hooks = { providers: validHooks.providers };
    const payload = { name: "prov", argument: { prompt_chat: [], mode: "model" } };

    it("routes an owner's `chunk` to the outstanding provider callback that takes chunks, ignores every other chunk, and fails the callback with a cancel when a text is too long", async () => {
        const h = harness();
        const link = h.open("a", { hooks });
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const chunks: string[] = [];
        const streamed = link.channel.callback("provider", payload, {
            onChunk: (text) => {
                chunks.push(text);
                if (text === "throws") {
                    throw new Error("handler broke");
                }
            },
        });
        const dispatched = h.last("callback");
        expect(dispatched).toMatchObject({ name: "provider", payload });
        const { id } = dispatched;
        // Ignored: another id, a text that is not a string, no text, a wrong message type.
        link.handleMessage({ type: "chunk", id: "nope", text: "x" });
        link.handleMessage({ type: "chunk", id, text: 5 });
        link.handleMessage({ type: "chunk", id });
        link.handleMessage({ type: "chunks", id, text: "x" });
        link.handleMessage({ type: "chunk", id, text: "" });
        link.handleMessage({ type: "chunk", id, text: "He" });
        // At the cap: taken.
        link.handleMessage({ type: "chunk", id, text: "x".repeat(MAX_PROVIDER_TEXT_CHARS) });
        // A handler that throws is logged; the callback goes on.
        link.handleMessage({ type: "chunk", id, text: "throws" });
        link.handleMessage({ type: "chunk", id, text: "Hello" });
        expect(chunks.map((text) => (text.length > 100 ? text.length : text))).toEqual([
            "",
            "He",
            MAX_PROVIDER_TEXT_CHARS,
            "throws",
            "Hello",
        ]);
        expect(errors).toHaveBeenCalledTimes(1);
        expect(await h.state(streamed)).toBe("pending");
        h.answer(link, id, { success: true, streamed: true });
        expect(await streamed).toEqual({ outcome: "answered", value: { success: true, streamed: true } });
        // A late chunk for the settled callback changes nothing; no cancel for an answered one.
        link.handleMessage({ type: "chunk", id, text: "late" });
        expect(chunks).toHaveLength(5);
        expect(h.ofType("cancel")).toHaveLength(0);

        // A callback that takes no chunks ignores them.
        const plain = link.channel.callback("editoutput", { text: "t" });
        const plainId = h.last("callback").id;
        link.handleMessage({ type: "chunk", id: plainId, text: "x" });
        expect(await h.state(plain)).toBe("pending");
        h.answer(link, plainId, "edited");
        expect(await plain).toEqual({ outcome: "answered", value: "edited" });

        // A text over the cap fails the callback as a protocol failure and tells the tab.
        const big = link.channel.callback("provider", payload, { onChunk: (text) => chunks.push(text) });
        const bigId = h.last("callback").id;
        link.handleMessage({ type: "chunk", id: bigId, text: "x".repeat(MAX_PROVIDER_TEXT_CHARS + 1) });
        expect(await big).toEqual({ outcome: "failed", failure: "protocol", error: "The provider's text is too long" });
        expect(h.last("cancel")).toMatchObject({ id: bigId });
        expect(chunks).toHaveLength(5);
        // The lane is free again.
        void link.channel.callback("editoutput", { text: "t" });
        expect(h.last("callback").name).toBe("editoutput");
        errors.mockRestore();
    });

    it("ends a callback when the caller's signal aborts (a cancel to the tab), settles one whose signal already aborted without dispatching it, and ignores an abort after the answer", async () => {
        const h = harness();
        const link = h.open("a", { hooks });
        const controller = new AbortController();
        const pending = link.channel.callback("provider", payload, { signal: controller.signal });
        const { id } = h.last("callback");
        expect(await h.state(pending)).toBe("pending");
        controller.abort();
        expect(await pending).toEqual({ outcome: "aborted", error: "The request ended" });
        expect(h.ofType("cancel").map((event) => event.id)).toEqual([id]);

        const dispatched = h.ofType("callback").length;
        const aborted = new AbortController();
        aborted.abort();
        expect(await link.channel.callback("provider", payload, { signal: aborted.signal })).toEqual({
            outcome: "aborted",
            error: "The request ended",
        });
        expect(h.ofType("callback")).toHaveLength(dispatched);
        expect(h.ofType("cancel")).toHaveLength(1);

        const later = new AbortController();
        const answered = link.channel.callback("provider", payload, { signal: later.signal });
        h.answer(link, h.last("callback").id, { success: true, content: "x" });
        expect(await answered).toEqual({ outcome: "answered", value: { success: true, content: "x" } });
        later.abort();
        expect(h.ofType("cancel")).toHaveLength(1);
        // Nothing is left on the lane: the next root callback is dispatched at once.
        void link.channel.callback("editoutput", { text: "t" });
        expect(h.ofType("callback")).toHaveLength(dispatched + 2);
    });
});
