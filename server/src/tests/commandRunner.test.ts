// @vitest-environment node
import { symlinkSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Chat } from "../../../shared/database.ts";
import type { GenerationCommand, GenerationEvent, GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { allowListenerOrigin, createSigner, createTestServer, json } from "./testSupport.ts";
import { UNHURRIED_CBS, UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

let server: ReturnType<typeof createTestServer>;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let bound = { presetId: "", modelPresetId: "", personaId: "" };

async function api(url: string, init: RequestInit = {}) {
    const response = await fetch(`${base}${url}`, {
        ...init,
        headers: {
            "risu-auth": await signer.jwt(),
            "x-resource-epoch": epoch,
            ...((init.headers as Record<string, string>) ?? {}),
        },
    });
    return { status: response.status, body: (await response.json()) as any };
}

beforeAll(async () => {
    server = createTestServer({
        password: "pw",
        scriptWorkerOptions: UNHURRIED_SCRIPT_WORKERS,
        cbsTimeLimits: UNHURRIED_CBS,
    });
    symlinkSync(path.resolve(import.meta.dirname, "../../../public"), path.join(server.rootDir, "public"), "dir");
    node = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", resolve));
    allowListenerOrigin(node);
    server.context.attachWebSocket(node);
    base = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
    signer = await createSigner();
    expect((await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }))).status).toBe(200);
    epoch = (await api("/api/resources/ui")).body.epoch;
    const firstId = async (kind: string) => (await api(`/api/resources/${kind}/main`)).body.data[0].id as string;
    bound = {
        presetId: await firstId("presets"),
        modelPresetId: await firstId("modelPresets"),
        personaId: await firstId("personas"),
    };
});

afterAll(async () => {
    await server?.close();
    if (node) {
        node.closeAllConnections();
        await new Promise<void>((resolve, reject) => node.close((error) => (error ? reject(error) : resolve())));
    }
});

const luaTrigger = (code: string) => ({
    comment: "Lua interaction",
    type: "manual",
    conditions: [],
    effect: [{ type: "triggerlua", code }],
});
const formHandler = (body: string) => `onFormSubmit = async(function(id, key, meta)\n${body}\nend)`;

let nextCharacter = 0;
async function seedCharacter(options: {
    codes: string[];
    type?: "character" | "group";
    lowLevelAccess?: boolean;
    moduleCode?: string;
}) {
    const characterId = `forms-${++nextCharacter}`;
    const moduleId = `module-${characterId}`;
    const ops: Record<string, unknown>[] = [];
    if (options.moduleCode) {
        const modules = (await api("/api/resources/modules/main")).body;
        ops.push({
            kind: "modules",
            id: "main",
            baseRevision: modules.revision ?? null,
            data: [
                ...(modules.data ?? []),
                {
                    id: moduleId,
                    name: "Form module",
                    description: "",
                    lowLevelAccess: true,
                    trigger: [luaTrigger(options.moduleCode)],
                },
            ],
        });
    }
    ops.push({
        kind: "characters",
        id: characterId,
        baseRevision: null,
        data: {
            chaId: characterId,
            name: "Form character",
            type: options.type ?? "character",
            ...(options.type === "group" ? { characters: [] } : {}),
            lowLevelAccess: options.lowLevelAccess ?? false,
            triggerscript: options.codes.map(luaTrigger),
            modules: options.moduleCode ? [moduleId] : [],
        },
    });
    expect(
        (
            await api(
                "/api/resources/batch",
                json({
                    ops,
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
                                        modelPresetId: bound.modelPresetId,
                                        promptPresetId: bound.presetId,
                                        bindedPersona: bound.personaId,
                                        message: [{ role: "user", data: "before submit", chatId: "m1" }],
                                    },
                                },
                            ],
                        },
                    ],
                }),
            )
        ).status,
    ).toBe(200);
    return characterId;
}

async function readChat(characterId: string) {
    const result = await api("/api/resources/read", json({ chats: [{ characterId, id: "k" }] }));
    expect(result.status).toBe(200);
    return result.body.chats[0] as { revision: string; data: Chat };
}

async function follow(jobId: string) {
    const socket = new WebSocket(
        `${base.replace("http", "ws")}/api/generations/${jobId}/ws` +
            `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab`,
    );
    const events: GenerationEvent[] = [];
    let finish!: (event: GenerationTerminalEvent) => void;
    let fail!: (error: Error) => void;
    const terminal = new Promise<GenerationTerminalEvent>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    const closed = new Promise<void>((resolve) =>
        socket.once("close", () => {
            fail(new Error("The owner socket closed without a terminal event"));
            resolve();
        }),
    );
    socket.on("error", fail);
    socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as GenerationEvent;
        events.push(event);
        if (event.type === "done" || event.type === "error") {
            finish(event);
        } else if (event.type === "callback" || event.type === "question") {
            // A permission regression must fail immediately, without waiting on a channel deadline.
            fail(new Error(`Unexpected ${event.type} from a Lua form`));
        }
    });
    try {
        return { terminal: await terminal, events };
    } finally {
        socket.close();
        await closed;
    }
}

async function runCommand(characterId: string, command: GenerationCommand) {
    const created = await api(
        "/api/generations",
        json({
            kind: "command",
            clientId: "tab",
            context: {
                characterId,
                chatId: "k",
                ...bound,
                mode: command.type,
                input: "",
                chatRevision: (await readChat(characterId)).revision,
            },
            command,
        }),
    );
    expect(created.status).toBe(200);
    return follow(created.body.jobId);
}

describe("Lua form command jobs", () => {
    it("delivers the form key and JSON data to both character triggers and a module trigger", async () => {
        const record = (label: string) =>
            formHandler(`
            local data = json.decode(meta).data
            addChat(id, "char", "${label}:" .. key .. ":" .. data.answer .. ":" ..
                #data.choices .. ":[" .. data.choices[1] .. "]:" .. data.choices[2] .. ":" .. data.__proto__)
        `);
        const characterId = await seedCharacter({
            codes: [record("first"), record("second")],
            moduleCode: record("module"),
        });
        const { terminal } = await runCommand(characterId, {
            type: "form",
            key: "survey-한",
            values: { answer: "hello", choices: ["", "second"], ["__proto__"]: "kept" },
        });
        expect(terminal.type).toBe("done");
        expect((await readChat(characterId)).data.message.map(({ role, data }) => ({ role, data }))).toEqual([
            { role: "user", data: "before submit" },
            { role: "char", data: "first:survey-한:hello:2:[]:second:kept" },
            { role: "char", data: "second:survey-한:hello:2:[]:second:kept" },
            { role: "char", data: "module:survey-한:hello:2:[]:second:kept" },
        ]);
    });

    it("refuses a form in a group chat with a 400 terminal and leaves the chat unchanged", async () => {
        const characterId = await seedCharacter({
            type: "group",
            codes: [formHandler('addChat(id, "char", "must not run")')],
        });
        const before = await readChat(characterId);
        const { terminal } = await runCommand(characterId, { type: "form", key: "survey", values: {} });
        expect(terminal).toMatchObject({
            type: "error",
            status: 400,
            message: "Forms do not run in a group chat",
            stage: "setup",
        });
        expect(await readChat(characterId)).toEqual(before);
    });

    it("gives form handlers the same per-trigger low-level permissions as button handlers", async () => {
        const guarded = (label: string) => `
            local function record(id)
                local lore = loadLoreBooksMain(id):await()
                addChat(id, "char", "${label}:" .. type(lore))
            end
            onFormSubmit = async(function(id, key, meta) record(id) end)
            onButtonClick = async(function(id, data) record(id) end)
        `;
        const characterId = await seedCharacter({
            codes: [guarded("character")],
            lowLevelAccess: false,
            moduleCode: guarded("module"),
        });
        for (const command of [
            { type: "form", key: "survey", values: {} },
            { type: "button", data: "survey" },
        ] satisfies GenerationCommand[]) {
            const { terminal, events } = await runCommand(characterId, command);
            expect(terminal.type).toBe("done");
            expect(events.filter((event) => event.type === "callback" || event.type === "question")).toEqual([]);
        }
        expect((await readChat(characterId)).data.message.map((message) => message.data)).toEqual([
            "before submit",
            "character:nil",
            "module:string",
            "character:nil",
            "module:string",
        ]);
    });
});
