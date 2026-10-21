// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    SERVER_CBS_JOB_MS,
    SERVER_CBS_MAX_MS,
    SERVER_CBS_MAX_WORK,
    serverCbsLimits,
    type ServerCbsTimeLimits,
} from "../jobs/cbsHost.ts";
import { allowTestLoopbackOrigin, createResourceTestClient, waitFor, type ResourceTestClient } from "./testSupport.ts";

// The CBS wall-time option (`createServerContext`'s `cbsTimeLimits`, through `createTestServer`),
// observed where production builds its limits (`serverCbsLimits` in `server/src/lua/bindings.ts` and
// `server/src/translation/runner.ts`): a command job's manual trigger effect and a render's CBS stage
// (the bindings, through `GenerationRunnerDeps` and `createRunSetup`), and a translation's JSON
// schema (the translation runner). Each path's first parse runs under a stepped `performance.now`
// (the evaluator's default clock): every read advances it further than any configured allowance,
// so the parse's first clock check is past the allowance the limits name, and the limit's message
// names the configured value (the template time when it is the smaller allowance, the job's
// otherwise). The defaults and the mapping of the option's fields are a unit check. No case waits
// for real time to pass.

/** `performance.now` advancing `stepMs` per read on top of the real clock (monotonic). */
function stepClock(stepMs: number) {
    const real = performance.now.bind(performance);
    let offset = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => real() + (offset += stepMs));
    return () => spy.mockRestore();
}
/** Past both configured allowances below in one read. */
const STEP_MS = 10_000;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("serverCbsLimits", () => {
    it("keeps the production times by default and takes the option's template and job times", () => {
        const usage = { usedMs: 0 };
        expect([SERVER_CBS_MAX_MS, SERVER_CBS_JOB_MS]).toEqual([5000, 60_000]);
        expect(serverCbsLimits(usage)).toEqual({
            maxWork: SERVER_CBS_MAX_WORK,
            maxMs: 5000,
            total: { usage, maxMs: 60_000 },
        });
        const limits = serverCbsLimits(usage, { templateMs: 4321, jobMs: 7654 });
        expect(limits).toEqual({ maxWork: SERVER_CBS_MAX_WORK, maxMs: 4321, total: { usage, maxMs: 7654 } });
        // The job's shared usage object, not a copy: every evaluator of the job charges the same one.
        expect(limits.total!.usage).toBe(usage);
        expect(limits.now).toBeUndefined();
    });
});

describe.each<{ time: ServerCbsTimeLimits; expected: RegExp }>([
    // The template allowance is the smaller: the parse ends on it.
    { time: { templateMs: 4321, jobMs: 7654 }, expected: /^CBS limit reached: one template took more than 4321 ms/ },
    // The job allowance is the smaller: the parse ends on what is left of it.
    {
        time: { templateMs: 7654, jobMs: 4321 },
        expected: /^CBS limit reached: the templates took more than 4321 ms in all/,
    },
])("a server with cbsTimeLimits $time", ({ time, expected }) => {
    let client: ResourceTestClient;
    let ids = { presetId: "", modelPresetId: "", personaId: "" };
    let unregister: () => void = () => {};

    const single = async (kind: string) =>
        (await (await client.get(kind, "main")).json()) as { revision: string; data: any };
    const write = async (kind: string, data: unknown) => {
        const current = await single(kind);
        const res = await client.put(kind, "main", { baseRevision: current.revision, data });
        expect(res.status, `${kind}: ${await res.clone().text()}`).toBe(200);
    };
    const readChat = async () =>
        ((await (await client.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }] })).json()) as any)
            .chats[0] as { revision: string; data: any };

    beforeAll(async () => {
        // A profile at a port nothing listens on: no path below reaches its provider.
        unregister = allowTestLoopbackOrigin("http://127.0.0.1:9");
        client = await createResourceTestClient({ cbsTimeLimits: time, generationAbortGraceMs: 10 * 60_000 });
        ids = {
            presetId: (await single("presets")).data[0].id,
            modelPresetId: (await single("modelPresets")).data[0].id,
            personaId: (await single("personas")).data[0].id,
        };
        // The character `c` (owner of the bound chat `k`): a manual trigger `go` whose effect parses
        // a variable name; the chat holds the message the translation targets.
        const seeded = await client.json("/api/resources/batch", {
            ops: [
                {
                    kind: "characters",
                    id: "c",
                    baseRevision: null,
                    data: {
                        chaId: "c",
                        name: "Owner",
                        triggerscript: [
                            {
                                comment: "go",
                                type: "manual",
                                conditions: [],
                                effect: [
                                    {
                                        type: "v2SetVar",
                                        indent: 0,
                                        var: "x",
                                        operator: "=",
                                        value: "1",
                                        valueType: "value",
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: "k",
                                name: "K",
                                fmIndex: -1,
                                modelPresetId: ids.modelPresetId,
                                promptPresetId: ids.presetId,
                                bindedPersona: ids.personaId,
                                message: [
                                    { role: "user", data: "q", chatId: "u" },
                                    { role: "char", data: "reply", chatId: "r" },
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        expect(seeded.status, await seeded.clone().text()).toBe(200);
    });
    afterAll(async () => {
        await client?.close();
        unregister();
    });

    it("bounds a command job's trigger effect (the bindings' host) by the configured times", async () => {
        const restore = stepClock(STEP_MS);
        try {
            const created = await client.json("/api/generations", {
                kind: "command",
                clientId: "tab",
                command: { type: "manual", name: "go" },
                context: {
                    characterId: "c",
                    chatId: "k",
                    ...ids,
                    selectedPersonaId: ids.personaId,
                    mode: "button",
                    input: "",
                    chatRevision: (await readChat()).revision,
                },
            });
            expect(created.status, await created.clone().text()).toBe(200);
            const { jobId } = (await created.json()) as { jobId: string };
            let status: any;
            await waitFor(async () => {
                status = await (await client.request(`/api/generations/${jobId}?clientId=tab`)).json();
                return status.state === "ended";
            });
            expect(status.terminal, JSON.stringify(status.terminal)).toMatchObject({ type: "error", stage: "script" });
            expect(status.terminal.message).toMatch(expected);
            expect(status.terminal.message).toMatch(/\(Owner\)$/);
        } finally {
            restore();
        }
    });

    it("bounds a render's CBS stage (the bindings' host through the transform) by the configured times", async () => {
        const restore = stepClock(STEP_MS);
        try {
            const res = await client.json("/api/transform", {
                clientId: "tab",
                mode: "editprocess",
                context: { characterId: "c", chatId: "k", ...ids, selectedPersonaId: ids.personaId },
                targets: [{ id: "t", kind: "text", sourceId: "c", chatIndex: -1, source: "plain text" }],
            });
            expect(res.status, await res.clone().text()).toBe(200);
            const body = (await res.json()) as { results: { id: string; ok: boolean; error?: string }[] };
            expect(body.results).toEqual([{ id: "t", ok: false, error: expect.stringMatching(expected) }]);
            expect(body.results[0].error).toMatch(/\(Owner\)$/);
        } finally {
            restore();
        }
    });

    it("bounds a translation's CBS (the translation runner's host) by the configured times", async () => {
        // The request layer parses a prompt preset's `interface` JSON schema with the run's evaluator
        // before any provider request (`server/src/llm/jsonSchema.ts`).
        const presets = await single("presets");
        presets.data[0] = {
            ...presets.data[0],
            jsonSchemaEnabled: true,
            jsonSchema: "interface Out {\n  text: string\n}",
        };
        await write("presets", presets.data);
        const profiles = await single("modelProfiles");
        profiles.data[0] = {
            ...profiles.data[0],
            modelId: "reverse_proxy",
            forceReplaceUrl: "http://127.0.0.1:9/v1/chat/completions",
            customProxyRequestModel: "mock-model",
            customAPIFormat: 0,
        };
        await write("modelProfiles", profiles.data);
        const providers = await single("providers");
        await write("providers", { ...providers.data, requestRetrys: 0 });
        const media = await single("memoryTranslateMedia");
        await write("memoryTranslateMedia", { ...media.data, translator: "ko" });

        const restore = stepClock(STEP_MS);
        try {
            const res = await client.json("/api/translate/message", {
                characterId: "c",
                chatId: "k",
                messageId: "r",
                ...ids,
            });
            const body = (await res.json()) as { error?: string };
            expect(res.status, JSON.stringify(body)).toBe(502);
            expect(body.error).toMatch(expected);
        } finally {
            restore();
        }
        expect((await readChat()).data.message[1].translation).toBeUndefined();
        expect(client.context.translationRunner.runningCount()).toBe(0);
    });
});
