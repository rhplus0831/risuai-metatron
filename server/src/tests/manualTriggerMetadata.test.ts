// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import type { GenerationStatus } from "../../../shared/jobs.ts";
import { createResourceTestClient, type ResourceTestClient, sleep } from "./testSupport.ts";

// The real command route and default runner, without an owner socket. Count executed transcript
// SELECTs and transactions only from admission through the terminal, excluding fixture/readback IO.
let client: ResourceTestClient;
let bound: { presetId: string; modelPresetId: string; personaId: string };
let counting = false;
let messageReads = 0;
let transactions = 0;
beforeAll(async () => {
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        if (sql === "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position") {
            const all = statement.all;
            statement.all = function (...args) {
                if (counting) messageReads++;
                return Reflect.apply(all, this, args);
            };
        }
        return statement;
    });
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        if (counting && /^BEGIN\b/i.test(sql)) transactions++;
        return exec.call(this, sql);
    });

    client = await createResourceTestClient();
    const first = async (kind: string) =>
        ((await (await client.get(kind, "main")).json()) as { data: { id: string }[] }).data[0].id;
    bound = {
        presetId: await first("presets"),
        modelPresetId: await first("modelPresets"),
        personaId: await first("personas"),
    };
});
afterAll(async () => {
    await client?.close();
    vi.restoreAllMocks();
});

describe("manual metadata jobs through the routes", () => {
    it.each(["variables", "author note"])(
        "keeps %s transcript reads bounded for 1 and 50 setters and stores exactly one revision per setter",
        async (field) => {
            const samples: { messageReads: number; overhead: number }[] = [];
            for (const count of [1, 50]) {
                const characterId = `${field.replaceAll(" ", "-")}-${count}`;
                const state: Record<string, string> = {};
                const effect = Array.from({ length: count }, (_, i) => {
                    // Each later setter evaluates CBS against the previous setter's stored value.
                    state[`$v${i}`] = i === 0 ? "seed" : `${state[`$v${i - 1}`]}/${i}`;
                    return field === "variables"
                        ? {
                              type: "v2SetVar",
                              indent: 0,
                              var: `v${i}`,
                              operator: "=",
                              valueType: "value",
                              value: i === 0 ? "seed" : `{{getvar::v${i - 1}}}/${i}`,
                          }
                        : { type: "v2SetAuthorNote", indent: 0, valueType: "value", value: `note ${i}` };
                });
                const message = [{ chatId: "m", role: "user", data: "unchanged transcript ".repeat(1000) }];
                const seeded = await client.json("/api/resources/batch", {
                    ops: [
                        {
                            kind: "characters",
                            id: characterId,
                            baseRevision: null,
                            data: {
                                chaId: characterId,
                                type: "character",
                                name: "Metadata",
                                triggerscript: [{ comment: "go", type: "manual", conditions: [], effect }],
                            },
                        },
                    ],
                    chats: [
                        {
                            characterId,
                            chatId: "k",
                            baseRevision: null,
                            ops: [
                                {
                                    op: "create",
                                    chat: {
                                        id: "k",
                                        name: "K",
                                        scriptstate: {},
                                        modelPresetId: bound.modelPresetId,
                                        promptPresetId: bound.presetId,
                                        bindedPersona: bound.personaId,
                                        message,
                                    },
                                },
                            ],
                        },
                    ],
                });
                expect(seeded.status).toBe(200);
                const read = async () => {
                    const response = await client.json("/api/resources/read", { chats: [{ characterId, id: "k" }] });
                    expect(response.status).toBe(200);
                    return ((await response.json()) as { chats: { revision: string; data: Chat }[] }).chats[0];
                };
                const before = await read();
                messageReads = transactions = 0;
                let terminal: GenerationStatus["terminal"];
                counting = true;
                try {
                    const response = await client.json("/api/generations", {
                        kind: "command",
                        clientId: "tab",
                        command: { type: "manual", name: "go" },
                        context: {
                            characterId,
                            chatId: "k",
                            ...bound,
                            mode: "manual",
                            input: "",
                            chatRevision: before.revision,
                        },
                    });
                    expect(response.status).toBe(200);
                    const { jobId } = (await response.json()) as { jobId: string };
                    for (let i = 0; i < 500; i++) {
                        const status = await client.request(`/api/generations/${jobId}?clientId=tab`);
                        expect(status.status).toBe(200);
                        terminal = ((await status.json()) as GenerationStatus).terminal;
                        if (terminal) break;
                        await sleep(10);
                    }
                } finally {
                    counting = false;
                }
                expect(terminal?.type).toBe("done");
                samples.push({ messageReads, overhead: transactions - count });
                expect(messageReads > 0 && messageReads <= 4, `transcript reads: ${messageReads}; budget: 1..4`).toBe(
                    true,
                );
                expect(transactions).toBe(count);
                const after = await read();
                expect(after.data.message).toEqual(message);
                if (field === "variables") expect(after.data.scriptstate).toEqual(state);
                else expect(after.data.note).toBe(`note ${count - 1}`);
                const parts = before.revision.split(":");
                parts[2] = String(Number(parts[2]) + count);
                expect(after.revision).toBe(parts.join(":"));
                expect(terminal).toMatchObject({ type: "done", revision: after.revision });
            }
            expect(samples[1]).toEqual(samples[0]);
        },
    );
});
