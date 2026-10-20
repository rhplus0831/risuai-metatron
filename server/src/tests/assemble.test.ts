// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import { assemblePrompt, type AssemblyHost } from "../prompt/assemble.ts";
import {
    normalizePreset,
    PERSONA_ROOT_ALIASES,
    PRESET_DEFAULTS,
    PRESET_ROOT_ALIASES,
} from "../../../shared/presets.ts";
import { FORWARDED_MODEL_PRESET_KEYS, FORWARDED_PRESET_KEYS, SECTION_FIELDS } from "../../../shared/sections.ts";
import { allowListenerOrigin, createSigner, createTestServer, json } from "./testSupport.ts";

// Phase 5 slice 9: the prompt golden. The server `preview` job (`server/src/prompt/runner.ts`
// `runPromptJob`, `server/src/prompt/assemble.ts` `assemblePrompt`) on a real listening server with
// the default runner, seeded from the baseline scenario (`fixtures/baseline/scenario.json`, applied
// as the browser capture applied it: the base settings and the fixture's own onto the selected
// `Default` preset, the selected persona, and the settings sections), must produce the `formated`
// the browser path produced (`fixtures/baseline/prompts.json`, captured before any server code
// existed), the `lore` fixture taking the approved delta (`deltas/lore-regex-fix-prompts.json`). A
// difference here is a parity defect to attribute, never a fixture to recapture. The `presetChain`
// fixture also pins the `preset` event (the pick with the seeded random), and the `jinja` fixture
// the `previewPrompt` job's provider body against the captured one.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(import.meta.dirname, "fixtures/baseline");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
const SLOW = 60_000;

type Fixture = { name: string; chaId: string; chatId: string; settings?: Record<string, unknown> };
type Captured = Record<string, { formated: OpenAIChat[]; selectedPresetName: string; previewBody?: unknown }>;

const scenario = readJson("scenario.json") as {
    environment: { randomSeed: number; viewport: { width: number; height: number }; locale: string };
    baseSettings: Record<string, unknown>;
    personas: Record<string, unknown>[];
    presets: Record<string, unknown>[];
    characters: Record<string, any>[];
    prompts: Fixture[];
};
const prompts = readJson("prompts.json") as Captured;
const loreDelta = readJson("deltas/lore-regex-fix-prompts.json") as {
    fixtures: { lore: { formated: OpenAIChat[] } };
};

/** The capture's `Math.random`: mulberry32, re-seeded before every capture unit. */
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Server = {
    rootDir: string;
    base: string;
    signer: Awaited<ReturnType<typeof createSigner>>;
    api(url: string, init?: RequestInit): Promise<{ status: number; body: any }>;
    single(kind: string): Promise<any>;
    reseed(): void;
    close(): Promise<void>;
};
let servers: Server[] = [];

/** A listening server with the default runner, its random re-seeded by `reseed()`. */
async function startServer(): Promise<Server> {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-assemble-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    let random = mulberry32(scenario.environment.randomSeed);
    const server = createTestServer({ rootDir, generationRandom: () => random() });
    const node = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", () => resolve()));
    allowListenerOrigin(node);
    server.context.attachWebSocket(node);
    const base = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
    const signer = await createSigner();
    await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
    const epoch = (
        (await (await fetch(`${base}/api/resources/ui`, { headers: { "risu-auth": await signer.jwt() } })).json()) as {
            epoch: string;
        }
    ).epoch;
    const api = async (url: string, init: RequestInit = {}) => {
        const res = await fetch(`${base}${url}`, {
            ...init,
            headers: {
                "risu-auth": await signer.jwt(),
                "x-resource-epoch": epoch,
                "content-type": "application/json",
                ...((init.headers as Record<string, string>) ?? {}),
            },
        });
        let body: any = null;
        try {
            body = await res.json();
        } catch {}
        return { status: res.status, body };
    };
    const started: Server = {
        rootDir,
        base,
        signer,
        api,
        single: async (kind: string) => (await api(`/api/resources/${kind}/main`)).body,
        reseed() {
            random = mulberry32(scenario.environment.randomSeed);
        },
        async close() {
            await server.close();
            node.closeAllConnections();
            await new Promise((resolve) => node.close(resolve));
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
    servers.push(started);
    return started;
}

/**
 * Seeds the scenario for one fixture the way the capture applied it: `baseSettings` then the
 * fixture's `settings`, each key to its home (a persona root alias onto the selected persona, a
 * forwarded prompt preset key onto the selected `Default` preset under its field name, a forwarded
 * model key onto the materialized model preset's main profile (`aiModel` as its `modelId`, the
 * profile options as they are; `subModel` the sub slot's model, `docs/plan/model-profiles.md`),
 * else the section holding it); the two extra presets through `normalizePreset`; every character
 * with its chats.
 */
async function seed(s: Server, fixture: Fixture) {
    const settings = { ...scenario.baseSettings, ...fixture.settings };
    const presets = await s.single("presets");
    const modelPresets = await s.single("modelPresets");
    const modelProfiles = await s.single("modelProfiles");
    const defaultPreset: Record<string, unknown> = { ...presets.data[0], name: "Default" };
    const modelPreset: Record<string, unknown> = { ...modelPresets.data[0], name: "Default" };
    const mainProfile: Record<string, unknown> = { ...modelProfiles.data[0], name: "Default" };
    let subModel: string | undefined;
    const personas = structuredClone(scenario.personas) as Record<string, any>[];
    const selected = personas[(settings.selectedPersona as number | undefined) ?? 0];
    const sectionPatch: Record<string, Record<string, unknown>> = {};
    const forwarded = new Set<string>(FORWARDED_PRESET_KEYS as readonly string[]);
    const forwardedModel = new Set<string>(FORWARDED_MODEL_PRESET_KEYS as readonly string[]);
    const presetField = PRESET_ROOT_ALIASES as Record<string, string>;
    const personaField = PERSONA_ROOT_ALIASES as Record<string, string>;
    for (const [key, value] of Object.entries(settings)) {
        if (key === "selectedPersona") {
            continue;
        }
        if (Object.hasOwn(personaField, key)) {
            selected[personaField[key]] = value;
            continue;
        }
        if (forwarded.has(key)) {
            defaultPreset[presetField[key] ?? key] = structuredClone(value);
            continue;
        }
        if (forwardedModel.has(key)) {
            // The capture's settings hold no auxiliary slot choices; a model preset seed would need them.
            expect(key, `the model setting ${key} has a seed`).not.toBe("seperateModels");
            if (key === "aiModel") {
                mainProfile.modelId = value;
            } else if (key === "subModel") {
                subModel = value as string;
            } else if (key === "seperateModelsForAxModels") {
                modelPreset[key] = value;
            } else {
                mainProfile[key] = structuredClone(value);
            }
            continue;
        }
        const section = Object.entries(SECTION_FIELDS).find(([, fields]) =>
            (fields as readonly string[]).includes(key),
        )?.[0];
        // A setting with no home would be silently dropped from the seed: not a parity run.
        expect(section, `the setting ${key} has a home`).toBeDefined();
        (sectionPatch[section!] ??= {})[key] = structuredClone(value);
    }
    if (fixture.name === "presetChain") {
        // The capture's `presetChain` pick switched the whole preset: `Alpha`, a canonical preset,
        // brought the schema's default model with it. A pick changes the prompt preset only now
        // (`docs/plan/split-preset.md`), so the model the capture assembled with is seeded as the
        // job's model preset's profile.
        mainProfile.modelId = PRESET_DEFAULTS.modelId;
        subModel = PRESET_DEFAULTS.modelId!;
    }
    // One profile when the main and sub models agree (every capture fixture), else a sub profile
    // with the same options, as the shared model preset fields applied to both.
    const profiles = [mainProfile];
    modelPreset.mainSlot = { profileId: mainProfile.id };
    modelPreset.subSlot = { profileId: mainProfile.id };
    if (subModel !== undefined && subModel !== mainProfile.modelId) {
        profiles.push({ ...mainProfile, id: "sub", name: "Sub", modelId: subModel });
        modelPreset.subSlot = { profileId: "sub" };
    }
    const ops: unknown[] = [
        {
            kind: "presets",
            id: "main",
            baseRevision: presets.revision,
            data: [
                defaultPreset,
                ...scenario.presets.map((preset) => normalizePreset(structuredClone(preset) as never)),
            ],
        },
        { kind: "modelProfiles", id: "main", baseRevision: modelProfiles.revision, data: profiles },
        { kind: "modelPresets", id: "main", baseRevision: modelPresets.revision, data: [modelPreset] },
        { kind: "personas", id: "main", baseRevision: (await s.single("personas")).revision, data: personas },
    ];
    for (const [section, patch] of Object.entries(sectionPatch)) {
        const current = await s.single(section);
        ops.push({ kind: section, id: "main", baseRevision: current.revision, data: { ...current.data, ...patch } });
    }
    const chats: unknown[] = [];
    for (const character of scenario.characters) {
        const { chats: charChats, chatPage: _chatPage, ...data } = structuredClone(character);
        ops.push({ kind: "characters", id: character.chaId, baseRevision: null, data });
        for (const chat of charChats ?? []) {
            chats.push({
                characterId: character.chaId,
                chatId: chat.id,
                baseRevision: null,
                // The capture had no chat binding (`docs/plan/chat-binding.md`): each chat is bound to the
                // ids the preview job sends, keeping a bound persona the fixture holds (else the selected one).
                ops: [
                    {
                        op: "create",
                        chat: {
                            ...chat,
                            modelPresetId: modelPreset.id,
                            promptPresetId: defaultPreset.id,
                            bindedPersona: chat.bindedPersona ?? selected.id,
                        },
                    },
                ],
            });
        }
    }
    const seeded = await s.api("/api/resources/batch", { method: "POST", body: JSON.stringify({ ops, chats }) });
    expect(seeded.status, JSON.stringify(seeded.body).slice(0, 500)).toBe(200);
    return {
        presets: (await s.single("presets")).data as { id: string; name: string }[],
        modelPresetId: modelPreset.id as string,
        selectedPersona: selected,
    };
}

/** Runs a preview job for the fixture and collects its events to the terminal. */
async function previewJob(s: Server, fixture: Fixture, kind: "preview" | "previewPrompt") {
    const { presets, modelPresetId, selectedPersona } = await seed(s, fixture);
    const read = await s.api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: fixture.chaId, id: fixture.chatId }] }),
    });
    const chat = read.body.chats[0] as { revision: string; data: { bindedPersona?: string } };
    s.reseed();
    const created = await s.api("/api/generations", {
        method: "POST",
        body: JSON.stringify({
            kind,
            clientId: "tab",
            context: {
                characterId: fixture.chaId,
                chatId: fixture.chatId,
                presetId: presets[0].id,
                modelPresetId,
                personaId: chat.data.bindedPersona ?? selectedPersona.id,
                selectedPersonaId: selectedPersona.id,
                mode: kind,
                input: "",
                chatRevision: chat.revision,
                client: { viewport: scenario.environment.viewport, browserLanguage: scenario.environment.locale },
            },
        }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const url =
        `${s.base.replace("http", "ws")}/api/generations/${created.body.jobId}/ws` +
        `?risu-auth=${encodeURIComponent(await s.signer.jwt())}&clientId=tab&attach=1`;
    const ws = new WebSocket(url);
    const events: any[] = [];
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 45_000);
        ws.onmessage = (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve();
            }
        };
    });
    ws.close();
    return { events, terminal: events.at(-1), presets };
}

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    vi.restoreAllMocks();
});

describe("the prompt golden (the browser capture)", () => {
    const fixtureOf = (name: string) => scenario.prompts.find((fixture) => fixture.name === name)!;
    const expectedOf = (name: string) => (name === "lore" ? loreDelta.fixtures.lore.formated : prompts[name].formated);

    for (const name of ["plain", "group", "jinja", "lore"]) {
        it(
            `assembles the ${name} fixture's prompt as the browser did`,
            async () => {
                const s = await startServer();
                const { terminal } = await previewJob(s, fixtureOf(name), "preview");
                expect(terminal.type, JSON.stringify(terminal)).toBe("done");
                expect(terminal.result).toEqual(expectedOf(name));
                expect(terminal.stopped).toBeUndefined();
            },
            SLOW,
        );
    }

    it(
        "picks the presetChain preset with the seeded random, tells the tab, and assembles with it",
        async () => {
            const s = await startServer();
            const { events, terminal, presets } = await previewJob(s, fixtureOf("presetChain"), "preview");
            expect(terminal.type, JSON.stringify(terminal)).toBe("done");
            expect(terminal.result).toEqual(expectedOf("presetChain"));
            const picked = events.filter((event) => event.type === "preset");
            expect(picked).toHaveLength(1);
            expect(presets.find((preset) => preset.id === picked[0].presetId)?.name).toBe(
                prompts.presetChain.selectedPresetName,
            );
            // The pick comes before the speaker's work: after the first `accepted`, before `done`.
            expect(events.map((event) => event.type).indexOf("preset")).toBeGreaterThan(0);
        },
        SLOW,
    );

    it(
        "renders the jinja fixture's previewPrompt body (the Ooba request) as the browser did",
        async () => {
            const s = await startServer();
            const { terminal } = await previewJob(s, fixtureOf("jinja"), "previewPrompt");
            expect(terminal.type, JSON.stringify(terminal)).toBe("done");
            expect(typeof terminal.result).toBe("string");
            expect(JSON.parse(terminal.result)).toEqual(prompts.jinja.previewBody);
        },
        SLOW,
    );
});

describe("assemblePrompt final token recheck", () => {
    // Keep the public assembler real; only its I/O services and text encoder are deterministic.
    // One character is one text token, three tokens of overhead per message, and real image rules.
    function assembly(messages: { chatId: string; data: string }[], depthText: string) {
        const character = {
            ...scenario.characters[0],
            type: "character",
            chaId: "counter",
            name: "Counter",
            firstMessage: "",
            alternateGreetings: [],
            exampleMessage: "",
            desc: "",
            personality: "",
            scenario: "",
            additionalText: "",
            bias: [],
            depth_prompt: { depth: 0, prompt: depthText },
        } as unknown as AssemblyHost["speaker"];
        const chat: ReturnType<AssemblyHost["chat"]> = {
            id: "k",
            fmIndex: -1,
            name: "Counter",
            note: "",
            localLore: [],
            message: messages.map((message) => ({ ...message, role: "user" })),
        };
        const tokenizer = new ChatTokenCounter(3, "noName", {
            encode: async (text) => Array.from(text, (_, i) => i),
            supportsInlayImage: () => true,
            mainModel: () => resolveModelInfo("gpt4o"),
            gptVisionQuality: () => "high",
        });
        const host: AssemblyHost = {
            db: {
                ...scenario.baseSettings,
                ...normalizePreset({}),
                aiModel: "gpt4o",
                maxContext: 700,
                maxResponse: 10,
                bias: [],
                personaPrompt: "",
                promptInfoInsideChat: false,
                promptTemplate: [{ type: "chat", rangeStart: 0, rangeEnd: "end" }],
                promptSettings: { trimStartNewChat: true, sendName: false },
            } as unknown as AssemblyHost["db"],
            owner: character,
            speaker: character,
            chatRef: { chaId: "counter", chatId: "k" },
            parse: (text) => text,
            chat: () => chat,
            findCharacter: () => character,
            userName: () => "User",
            personaPrompt: () => "",
            activateLore: async () => ({ actives: [], matchLog: [] }),
            scripts: {
                process: async (_char, data) => ({ data, emoChanged: false }),
                editRequest: async (_char, messages) => messages,
            },
            runStartTrigger: async () => null,
            runEditRequest: async (messages) => messages,
            readInlay: async (id) => ({ type: "image", data: `data:image/png;base64,${id}`, width: 512, height: 512 }),
            readAsset: async () => null,
            moduleAssets: () => [],
            moduleToggles: () => "",
            runCurrentChatFunction() {},
            setLastMemory() {},
            memoryTrim: { enabled: () => false, confirm: async () => "trim" },
            memory: { embeddings: { db: {} } } as AssemblyHost["memory"],
            writeMemory() {},
            endMemoryProgress() {},
            captionImage: async () => {
                throw new Error("Images must remain multimodal");
            },
            tokenizer,
            getModelInfo: (id) => resolveModelInfo(id),
            fence() {},
        };
        return {
            tokenizer,
            host,
            chat,
            run: () =>
                assemblePrompt(host, {
                    chatAdditonalTokens: 3,
                    continue: false,
                    generationId: "counting",
                    stageTimings: { stage1Duration: 0, stage2Duration: 0 },
                }),
        };
    }

    it("snapshots toggle labels and raw text using chat, legacy, and kind defaults including the owner", async () => {
        const { host, chat, run } = assembly([{ chatId: "m", data: "hello" }], "");
        Object.assign(host.db, {
            promptInfoInsideChat: true,
            botPresets: [{ name: "Snapshot preset" }],
            botPresetsId: 0,
            customPromptTemplateToggle: [
                "mode=Default mode=select=First,Second",
                "pick=Picked mode=select=First,Second",
                "text=Cleared text=text",
                "area=Raw area=textarea",
                "empty_text=Unset text=text",
                "empty_area=Unset area=textarea",
                "on=Enabled checkbox",
                "off=Disabled checkbox",
                "odd=Non-one checkbox",
                "unset=Unset checkbox",
                "first=Preset first=text",
                "section=Section=group",
                "end=End=groupEnd",
                "rule=Rule=divider",
                "help=Help=caption",
            ].join("\n"),
            globalChatVariables: {
                toggle_pick: "0",
                toggle_text: "legacy text",
                toggle_area: "legacy\narea",
                toggle_on: "1",
                toggle_off: "1",
            },
        });
        chat.GLGlobalVariables = {
            toggle_pick: "1",
            toggle_text: "",
            toggle_off: "0",
            toggle_odd: "true",
            toggle_owner: "owner raw",
        };
        host.moduleToggles = () =>
            "module=Module mode=select=Module first,Module second\nfirst=Module duplicate\nmodule_first=Module first=text";
        host.owner = {
            ...host.owner,
            customModuleToggle:
                "owner=Owner text=textarea\nowner_mode=Owner mode=select=Owner first,Owner second\nmodule_first=Owner duplicate",
        } as AssemblyHost["owner"];
        // A group speaker can differ from the chat owner. Its toggles must not enter this snapshot.
        host.speaker = { ...host.speaker, customModuleToggle: "speaker=Speaker-only text=text" };
        const result = await run();
        expect(result.type).toBe("prompt");
        if (result.type !== "prompt") throw new Error(JSON.stringify(result));
        expect(result.promptInfo).toMatchObject({
            promptName: "Snapshot preset",
            promptToggles: [
                { key: "Default mode", value: "First" },
                { key: "Picked mode", value: "Second" },
                { key: "Cleared text", value: "" },
                { key: "Raw area", value: "legacy\narea" },
                { key: "Unset text", value: "" },
                { key: "Unset area", value: "" },
                { key: "Enabled checkbox", value: "ON" },
                { key: "Preset first", value: "" },
                { key: "Module mode", value: "Module first" },
                { key: "Module first", value: "" },
                { key: "Owner text", value: "owner raw" },
                { key: "Owner mode", value: "Owner first" },
            ],
        });
    });

    it("removes the whole trimmed message including its images and reports the returned prompt's token count", async () => {
        for (const suffix of [" {{inlay::first}} {{inlay::second}}", ""]) {
            const depth = "d".repeat(650);
            const { run, tokenizer } = assembly(
                [
                    { chatId: "old", data: "x".repeat(50) + suffix },
                    { chatId: "kept", data: "keep" },
                ],
                depth,
            );
            // Both histories fit before the late depth prompt; only the final recheck trims.
            const result = await run();
            expect(result.type).toBe("prompt");
            if (result.type !== "prompt") throw new Error(JSON.stringify(result));
            expect(result.formated.map(({ role, content, multimodals }) => ({ role, content, multimodals }))).toEqual([
                { role: "user", content: "keep", multimodals: undefined },
                { role: "system", content: depth, multimodals: undefined },
            ]);
            expect(result.generationInfo.inputTokens).toBe(660); // (4 + 3) + (650 + 3).
            expect(result.generationInfo.inputTokens).toBe(await tokenizer.tokenizeChats(result.formated));
        }
    });

    it("keeps an untrimmed image-only message even when a preceding text message is trimmed", async () => {
        const { run, tokenizer } = assembly(
            [
                { chatId: "old", data: "x".repeat(100) },
                { chatId: "image-only", data: "{{inlay::kept}}" },
            ],
            "d".repeat(400),
        );
        const result = await run();
        expect(result.type).toBe("prompt");
        if (result.type !== "prompt") throw new Error(JSON.stringify(result));
        expect(result.formated).toHaveLength(2);
        expect(result.formated[0]).toMatchObject({
            role: "user",
            content: "",
            memo: "image-only",
            multimodals: [{ type: "image", base64: "data:image/png;base64,kept", width: 512, height: 512 }],
        });
        expect(result.formated[1]).toEqual({ role: "system", content: "d".repeat(400) });
        expect(result.generationInfo.inputTokens).toBe(661); // 255 + 3 for the image message; 400 + 3 for depth.
        expect(result.generationInfo.inputTokens).toBe(await tokenizer.tokenizeChats(result.formated));
    });
});
