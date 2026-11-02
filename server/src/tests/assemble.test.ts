// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
    CONTEXT_MEMORY_EXCLUDED,
    type ContextReport,
    historyDigest,
    parseContextReport,
} from "../../../shared/contextReport.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { createHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import type { LoreActive } from "../../../shared/lore/activation.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import type { PromptItem } from "../../../shared/prompt.ts";
import { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import { tokenizerIdentityKey } from "../../../shared/tokenizerChoice.ts";
import { type RequestDb, tokenScopeFor } from "../llm/settings.ts";
import { assemblePrompt, type AssemblyHost, type AssemblyMemoryJob } from "../prompt/assemble.ts";
import { createVectorCache, type CachedVector } from "../data/vectorCache.ts";
import { createEmbeddings } from "../prompt/embeddings.ts";
import { messageSourceHash } from "../data/memoryStore.ts";
import type { MemoryEvent } from "../../../shared/structuredMemory.ts";
import type { MemoryRecords } from "../prompt/memory/structured/step.ts";
import { memoryRecords } from "./memoryFixtures.ts";
import type { MemoryHost } from "../prompt/memory/host.ts";
import {
    normalizePreset,
    PERSONA_ROOT_ALIASES,
    PRESET_DEFAULTS,
    PRESET_ROOT_ALIASES,
} from "../../../shared/presets.ts";
import { FORWARDED_MODEL_PRESET_KEYS, FORWARDED_PRESET_KEYS, SECTION_FIELDS } from "../../../shared/sections.ts";
import { allowListenerOrigin, createSigner, createTestServer, json } from "./testSupport.ts";

// The prompt golden. The server `preview` job (`server/src/prompt/runner.ts` `runPromptJob`,
// `server/src/prompt/assemble.ts` `assemblePrompt`) on a real listening server with the default
// runner, seeded from the baseline scenario (`fixtures/baseline/scenario.json`, applied as the
// browser capture applied it: the base settings and the fixture's own onto the selected `Default`
// preset, the selected persona, and the settings sections), must produce the `formated` the browser
// path produced (`fixtures/baseline/prompts.json`, captured before any server code existed), the
// `lore` fixture taking the approved delta (`deltas/lore-regex-fix-prompts.json`). A difference
// here is a parity defect to attribute, never a fixture to recapture. The `presetChain` fixture
// also pins the `preset` event (the pick with the seeded random), and the `jinja` fixture the
// `previewPrompt` job's provider body against the captured one.

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
    // The tokenizer payloads (the fixtures' Llama and Llama 3 families).
    mkdirSync(path.join(rootDir, "server"));
    symlinkSync(path.join(REPO_ROOT, "server/assets"), path.join(rootDir, "server/assets"), "dir");
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
 * profile options as they are; `subModel` the sub slot's model), else the section holding it);
 * the two extra presets through `normalizePreset`; every character with its chats.
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
        // brought the schema's default model with it. A pick now changes the prompt preset only (the
        // model fields live in model presets), so the model the capture assembled with is seeded as
        // the job's model preset's profile.
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
                // The capture had no chat binding: each chat is bound to the ids the preview job
                // sends, keeping a bound persona the fixture holds (else the selected one).
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
                expect(terminal.result.messages).toEqual(expectedOf(name));
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
            expect(terminal.result.messages).toEqual(expectedOf("presetChain"));
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
            count: async (text) => text.length,
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
            activateLore: async () => ({
                actives: [],
                matchLog: [],
                budget: { used: 0, limit: 0, rejectedCount: 0, rejectedTokens: 0, rejected: [] },
            }),
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
            stage() {},
            captionImage: async () => {
                throw new Error("Images must remain multimodal");
            },
            tokenizer,
            tokenScope: "counting",
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

describe("the context report", () => {
    // The report `assemblePrompt` writes into `generationInfo.context` (`shared/contextReport.ts`),
    // under the same deterministic counter as above: one character is one token, three tokens of
    // overhead per message, names uncounted. Every expected number below is computed by hand from
    // the texts, never from the assembler's own sums.
    type Entry = { chatId: string; data: string; role?: Message["role"]; disabled?: Message["disabled"] };
    type Options = {
        messages: Entry[];
        /** The character's first message; the default is "Hi!" (6 tokens). */
        greeting?: string;
        /** The character's example dialogue (`exampleMessage`). */
        examples?: string;
        /** The prompt template; `null` runs the legacy (no-template) path. */
        template?: PromptItem[] | null;
        maxContext?: number;
        db?: Record<string, unknown>;
        promptSettings?: Record<string, unknown>;
        character?: Record<string, unknown>;
        lore?: LoreActive[];
        editRequest?: (formated: OpenAIChat[]) => OpenAIChat[];
        hypaV3?: boolean;
        memoryJob?: AssemblyMemoryJob;
        /** The memory host's embeddings; the default fails on any use. */
        embeddings?: MemoryHost["embeddings"];
        /** The memory host's summary requests; the default fails on any use. */
        request?: MemoryHost["request"];
        /** Apply memory writes to the chat; the default drops them. */
        storeMemory?: boolean;
        /** The host's inlay reads; the default finds none. */
        readInlay?: AssemblyHost["readInlay"];
    };
    const CHAT_CARD: PromptItem = { type: "chat", rangeStart: 0, rangeEnd: "end" };
    const plain = (type2: "main" | "globalNote" | "normal", text: string): PromptItem => ({
        type: "plain",
        type2,
        text,
        role: "system",
    });
    // Nine rejected entries, the first with an 81-code-point name: the report keeps eight and
    // shortens that name, or the stored report would not parse.
    const LORE_BUDGET = {
        used: 12,
        limit: 100,
        rejectedCount: 9,
        rejectedTokens: 40,
        rejected: Array.from({ length: 9 }, (_, i) =>
            i === 0 ? { name: "n".repeat(81), tokens: 32 } : { name: `entry ${i}`, tokens: 1 },
        ),
    };
    const NEW_CHAT_TOKENS = "[Start a new chat]".length + 3; // 21
    const EMPTY_SUMMARY_CARD = "<Past Events Summary>\n\n</Past Events Summary>"; // 45 characters

    function contextAssembly(options: Options) {
        const preset = createHypaV3Preset("Test", { similarMemoryRatio: 0 }, "hypa-test");
        const character = {
            ...scenario.characters[0],
            type: "character",
            chaId: "counter",
            name: "Counter",
            firstMessage: options.greeting ?? "Hi!",
            alternateGreetings: [],
            exampleMessage: options.examples ?? "",
            desc: "",
            personality: "",
            scenario: "",
            additionalText: "",
            bias: [],
            depth_prompt: { depth: 0, prompt: "" },
            supaMemory: options.hypaV3 === true,
            systemPrompt: "",
            replaceGlobalNote: "",
            ...options.character,
        } as unknown as AssemblyHost["speaker"];
        const chat: Chat = {
            id: "k",
            fmIndex: -1,
            name: "Counter",
            note: "",
            localLore: [],
            message: options.messages.map(({ chatId, data, role, disabled }) => ({
                chatId,
                data,
                role: role ?? "user",
                ...(disabled === undefined ? {} : { disabled }),
            })),
        };
        const tokenizer = new ChatTokenCounter(3, "noName", {
            count: async (text) => text.length,
            supportsInlayImage: () => true,
            mainModel: () => resolveModelInfo("gpt4o"),
            gptVisionQuality: () => "high",
        });
        const counts = vi.spyOn(tokenizer, "tokenizeChat");
        const db = {
            ...scenario.baseSettings,
            ...normalizePreset({}),
            aiModel: "gpt4o",
            maxContext: options.maxContext ?? 400,
            maxResponse: 10,
            bias: [],
            personaPrompt: "",
            promptPreprocess: false,
            promptInfoInsideChat: false,
            mainPrompt: "",
            globalNote: "",
            jailbreakToggle: false,
            chainOfThought: false,
            formatingOrder: [
                "main",
                "description",
                "personaPrompt",
                "chats",
                "lastChat",
                "jailbreak",
                "lorebook",
                "globalNote",
                "authorNote",
            ],
            promptTemplate: options.template === null ? undefined : (options.template ?? [CHAT_CARD]),
            promptSettings: {
                trimStartNewChat: true,
                sendName: false,
                sendChatAsSystem: false,
                ...options.promptSettings,
            },
            supaModelType: "none",
            hanuraiEnable: false,
            hypav2: false,
            hypaV3: options.hypaV3 === true,
            hypaV3Presets: [preset],
            hypaV3PresetId: preset.id,
            ...options.db,
        } as unknown as AssemblyHost["db"];
        const memory: MemoryHost = {
            db,
            tokenize: async (text) => text.length,
            request:
                options.request ??
                (async () => {
                    throw new Error("No summary request runs in these tests");
                }),
            completions: async () => {
                throw new Error("No completion runs in these tests");
            },
            summarizer: async () => {
                throw new Error("No summarizer runs in these tests");
            },
            embeddings: options.embeddings ?? ({ db: {} } as unknown as MemoryHost["embeddings"]),
            regex: async () => {
                throw new Error("No regex runs in these tests");
            },
            parseChatML: () => null,
            userName: () => "User",
            progress() {},
            random: () => 0,
            redact: (text) => text,
            fence() {},
            signal: new AbortController().signal,
        };
        const host: AssemblyHost = {
            db,
            owner: character,
            speaker: character,
            chatRef: { chaId: "counter", chatId: "k" },
            parse: (text) => text,
            chat: () => chat,
            findCharacter: () => character,
            userName: () => "User",
            personaPrompt: () => "",
            activateLore: async () => ({ actives: options.lore ?? [], matchLog: [], budget: { ...LORE_BUDGET } }),
            scripts: {
                process: async (_char, data) => ({ data, emoChanged: false }),
                editRequest: async (_char, messages) => messages,
            },
            runStartTrigger: async () => null,
            runEditRequest: async (messages) => (options.editRequest ? options.editRequest(messages) : messages),
            readInlay: options.readInlay ?? (async () => null),
            readAsset: async () => null,
            moduleAssets: () => [],
            moduleToggles: () => "",
            runCurrentChatFunction() {},
            setLastMemory() {},
            memoryTrim: { enabled: () => false, confirm: async () => "trim" },
            memory,
            writeMemory(build) {
                const patch = options.storeMemory ? build(chat) : null;
                if (patch) {
                    Object.assign(chat, patch);
                }
            },
            endMemoryProgress() {},
            stage() {},
            captionImage: async () => {
                throw new Error("Images must remain multimodal");
            },
            tokenizer,
            tokenScope: "counting",
            getModelInfo: (id) => resolveModelInfo(id),
            fence() {},
            ...(options.memoryJob ? { memoryJob: options.memoryJob } : {}),
        };
        /** Runs the assembly and returns the prompt with its report, which must also parse as stored. */
        const run = async (input: { continue?: boolean; continueMessageId?: string } = {}) => {
            const result = await assemblePrompt(host, {
                chatAdditonalTokens: 3,
                continue: input.continue ?? false,
                ...(input.continueMessageId !== undefined ? { continueMessageId: input.continueMessageId } : {}),
                generationId: "counting",
                stageTimings: { stage1Duration: 0, stage2Duration: 0 },
            });
            expect(result.type, JSON.stringify(result)).toBe("prompt");
            if (result.type !== "prompt") throw new Error(JSON.stringify(result));
            const report = result.generationInfo.context!;
            expect(report).toBeDefined();
            expect(parseContextReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
            expect(report.input).toBe(result.generationInfo.inputTokens);
            expect(report.input).toBe(report.adjustment + report.sections.reduce((sum, row) => sum + row.tokens, 0));
            return {
                report,
                generationInfo: result.generationInfo,
                formated: result.formated,
                texts: result.formated.map((entry) => entry.content),
            };
        };
        return { run, chat, counts, host };
    }

    /** The report's fixed parts for this fixture. */
    const fixed = (chat: Chat, maxContext = 400) => ({
        v: 1 as const,
        maxContext,
        maxResponse: 10,
        lore: {
            budgetUsed: 12,
            budget: 100,
            rejectedCount: 9,
            rejectedTokens: 40,
            rejected: [
                { name: "n".repeat(79) + "…", tokens: 32 },
                ...Array.from({ length: 7 }, (_, i) => ({ name: `entry ${i + 1}`, tokens: 1 })),
            ],
            active: 0,
        },
        tokenScope: "counting",
        historyDigest: historyDigest(chat.message),
    });

    describe("structured memory selection", () => {
        /** Storage and job I/O only; the selector, card builder and report writer stay real. */
        function structuredAssembly(
            options: Options & {
                records?: MemoryRecords;
                settings?: Record<string, unknown>;
                preview?: boolean;
                gapConfirmTokens?: number;
            },
        ) {
            const records = options.records ?? {
                events: [],
                threads: [],
                pages: [],
                stage: [],
                runs: [],
                paused: false,
            };
            const preset = createHypaV3Preset(
                "Structured",
                {
                    budgetMode: "ratio",
                    memoryTokensRatio: 0.5,
                    gapConfirmTokens: options.gapConfirmTokens ?? 0,
                    structured: {
                        windowTurns: 1,
                        laneTargets: { pages: 0, events: 0, evidence: 0, threads: 300 },
                        ...options.settings,
                    },
                },
                "structured-test",
            );
            const confirmGap = vi.fn(async () => "continue" as const);
            const recordGap = vi.fn(async () => 0);
            const job: AssemblyMemoryJob = {
                ...selectOnlyJob,
                preview: options.preview ?? false,
                input: !options.preview,
                sourceGeneration: () => 1,
                confirmGap,
                structuredMemory: {
                    records: () => records,
                    recordGap,
                    taskInput: (sourceGeneration, confirmedBefore) => ({
                        kind: "structuredMemory",
                        confirmedBefore,
                        sourceGeneration,
                        chatRef: { chaId: "counter", chatId: "k" },
                        epoch: "epoch",
                        admittedRevision: "revision",
                        speakerId: "counter",
                        binding: { presetId: null, modelPresetId: null, personaId: null },
                        effective: { presetId: "preset", modelPresetId: "model", fromChain: false },
                        maxContext: options.maxContext ?? 400,
                        maxResponse: 10,
                        settingsFingerprint: "settings",
                        tokenPolicy: {
                            chatAdditionalTokens: 3,
                            useName: "noName",
                            mainModel: resolveModelInfo("gpt4o"),
                            supportsInlayImage: false,
                            tokenizer: {
                                aiModel: "gpt4o",
                                currentPluginProvider: "",
                                model: resolveModelInfo("gpt4o"),
                                pluginTokenizer: "",
                                customTokenizer: "",
                                googleClaudeTokenizing: false,
                                useTokenizerCaching: false,
                            },
                        },
                    }),
                },
            };
            const assembly = contextAssembly({
                ...options,
                hypaV3: true,
                memoryJob: job,
                db: {
                    ...options.db,
                    memoryAlgorithmType: "structuredMemory",
                    hypaV3Presets: [preset],
                    hypaV3PresetId: preset.id,
                },
            });
            return { ...assembly, confirmGap, recordGap, records };
        }
        const event = (id: string, ids: string[], patch: Partial<MemoryEvent> = {}): MemoryEvent => ({
            ...memoryRecords([id], id).events[0],
            createdRevision: 1,
            sources: ids.map((messageId, index) => ({ messageId, index, hash: "stored-source-hash" })),
            ...patch,
        });
        const stored = (events: MemoryEvent[], threads: MemoryRecords["threads"] = []): MemoryRecords => ({
            events,
            threads,
            pages: [],
            stage: [],
            runs: [],
            paused: false,
        });
        /** `records` with each event's sources anchored to `messages` as they stand. */
        const anchored = (records: MemoryRecords, messages: readonly Entry[]): MemoryRecords => ({
            ...records,
            events: records.events.map((entry) => ({
                ...entry,
                sources: entry.sources.map(({ messageId }) => {
                    const index = messages.findIndex(({ chatId }) => chatId === messageId);
                    return { messageId, index, hash: messageSourceHash({ role: "user", ...messages[index] }) };
                }),
            })),
        });
        const rawIds = (formated: OpenAIChat[]) =>
            formated.flatMap(({ memo }) => (memo && memo !== "supaMemory" ? [memo] : []));

        it("keeps stale sources raw in sends and reports their reasons without quoting or changing stored events", async () => {
            const dir = mkdtempSync(path.join(os.tmpdir(), "stale-memory-"));
            const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite"), now: () => 1000 });
            onTestFinished(() => {
                cache.close();
                rmSync(dir, { recursive: true, force: true });
            });
            const embeddings = createEmbeddings({
                cache,
                transformers: {
                    runEmbedding: async (texts) => texts.map(() => new Float32Array([1, 0])),
                    runSummarizer: async () => "",
                    runImageCaption: async () => "",
                    runTextGeneration: async () => "",
                    dispose: async () => {},
                },
            }).forJob({
                db: { hypaModel: "MiniLM" } as never,
                supaMemoryKey: "",
                signal: new AbortController().signal,
            });
            const messages: (Entry & Pick<Message, "role">)[] = [
                { chatId: "u1", role: "user", data: "Open the gate" },
                { chatId: "a1", role: "char", data: "The gate opens" },
                { chatId: "u2", role: "user", data: "Continue" },
                { chatId: "a2", role: "char", data: "Newest reply" },
                { chatId: "u3", role: "user", data: "Now" },
            ];
            const original = event("gate", [], {
                pinned: true,
                grade: 9,
                summary: "OLD SUMMARY SENTINEL",
                keyLines: [{ speaker: "C", text: "OLD QUOTE SENTINEL" }],
                sources: messages
                    .slice(0, 2)
                    .map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) })),
            });
            const records = stored([original]);
            const before = structuredClone(records);
            const [u, a, ...tail] = messages;
            for (const row of [
                { reason: "changed", messages: [u, { ...a, data: "The gate is shut" }, ...tail] },
                { reason: "missing", messages: [u, ...tail] },
                {
                    reason: "inserted",
                    messages: [u, { chatId: "new", role: "user" as const, data: "Wait" }, a, ...tail],
                },
                { reason: "moved", messages: [a, u, ...tail] },
            ]) {
                const assembly = structuredAssembly({
                    records,
                    messages: row.messages,
                    embeddings,
                    db: { hypaModel: "MiniLM" },
                    maxContext: 6000,
                    settings: { laneTargets: { pages: 0, events: 500, evidence: 500, threads: 0 } },
                });
                const result = await assembly.run();
                expect(rawIds(result.formated), row.reason).toEqual(row.messages.map((m) => m.chatId));
                expect(result.report.memory?.items, row.reason).toEqual([]);
                expect(result.report.memory?.excluded, row.reason).toEqual([
                    { id: "gate", kind: "event", lane: "events", reason: "stale", staleReason: row.reason },
                ]);
                const prompt = result.formated.map((m) => m.content).join("\n");
                expect(prompt).not.toContain("OLD SUMMARY SENTINEL");
                expect(prompt).not.toContain("OLD QUOTE SENTINEL");
                expect(records).toEqual(before);
            }
            const restored = await structuredAssembly({ records, messages, maxContext: 6000 }).run();
            expect(rawIds(restored.formated)).toEqual(["u2", "a2", "u3"]);
            expect(restored.report.memory?.items).toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "gate", verified: true })]),
            );
            expect(records).toEqual(before);
        });

        it("reports required and related pages in their lanes and verifies their tags in the final prompt", async () => {
            const dir = mkdtempSync(path.join(os.tmpdir(), "page-manifest-"));
            const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite"), now: () => 1000 });
            onTestFinished(() => {
                cache.close();
                rmSync(dir, { recursive: true, force: true });
            });
            const embeddings = createEmbeddings({
                cache,
                transformers: {
                    runEmbedding: async (texts) => texts.map(() => new Float32Array([1, 0])),
                    runSummarizer: async () => "",
                    runImageCaption: async () => "",
                    runTextGeneration: async () => "",
                    dispose: async () => {},
                },
            }).forJob({
                db: { hypaModel: "MiniLM" } as never,
                supaMemoryKey: "",
                signal: new AbortController().signal,
            });
            for (const removeTag of [false, true]) {
                const [scene, charter, ada, hidden] = memoryRecords(["scene", "charter", "ada", "hidden"]).pages;
                Object.assign(scene, { type: "scene", title: "At the gate", participants: ["ada"], sections: [] });
                Object.assign(charter, { title: "Charter", contextMode: "always" });
                Object.assign(ada, {
                    type: "character",
                    title: "Ada",
                    sections: [{ ...ada.sections[0], heading: "currentState", body: "Waiting patiently" }],
                });
                hidden.contextMode = "never";
                const records = { ...stored([]), pages: [scene, charter, ada, hidden], stage: ["ada"] };
                const assembly = structuredAssembly({
                    embeddings,
                    db: { hypaModel: "MiniLM" },
                    messages: fiveMessages,
                    maxContext: 10000,
                    records,
                    settings: {
                        flowEvents: 0,
                        requiredCap: 1200,
                        laneTargets: { pages: 600, events: 0, evidence: 0, threads: 0 },
                        volatileBeforeLastUser: true,
                    },
                    template: [{ type: "memory" }, CHAT_CARD],
                    editRequest: (entries) =>
                        entries.map((entry) => ({
                            ...entry,
                            content: entry.content.replace("[m:ada]", removeTag ? "[removed]" : "[m:ada]"),
                        })),
                });
                const result = await assembly.run();
                const stable = result.formated.find(({ memo }) => memo === "supaMemory")!.content;
                expect(stable).toContain("[m:scene] At the gate | present: Ada");
                expect(stable).toContain("[m:charter]");
                expect(stable).not.toContain("Waiting patiently");
                expect(result.texts.at(-2)).toContain("Ada | currentState: Waiting patiently");
                expect(result.texts.at(-1)).toBe(fiveMessages.at(-1)!.data);
                expect(result.report.memory).toMatchObject({
                    items: [
                        { id: "scene", kind: "page", lane: "required", verified: true },
                        { id: "charter", kind: "page", lane: "required", verified: true },
                        { id: "ada", kind: "page", lane: "pages", verified: !removeTag },
                    ],
                    excluded: expect.arrayContaining([{ id: "hidden", kind: "page", lane: "pages", reason: "never" }]),
                    lanes: expect.arrayContaining([
                        { lane: "required", target: 1200, spent: expect.any(Number) },
                        {
                            lane: "pages",
                            target: 600,
                            spent: "[m:ada] Ada | currentState: Waiting patiently".length + 3,
                        },
                    ]),
                });
                expect(result.report.memory!.lanes!.find(({ lane }) => lane === "required")!.spent).toBeGreaterThan(0);
                expect(result.texts.join("\n")).not.toContain("[m:hidden]");
            }
        });

        it("returns a named alert for required overflow in sends and previews even with inlay errors enabled", async () => {
            for (const preview of [false, true]) {
                for (const requiredCap of [1, 10000]) {
                    const [scene, charter] = memoryRecords(["scene", "charter"]).pages;
                    Object.assign(scene, {
                        type: "scene",
                        title: "Gate scene",
                        participants: [],
                        sections: [{ ...scene.sections[0], body: "Whole scene ".repeat(100) }],
                    });
                    Object.assign(charter, { title: "Binding charter", contextMode: "always" });
                    const assembly = structuredAssembly({
                        messages: fiveMessages,
                        maxContext: 1000,
                        preview,
                        db: { inlayErrorResponse: true },
                        records: { ...stored([]), pages: [scene, charter] },
                        settings: { requiredCap, flowEvents: 0 },
                    });
                    const before = structuredClone(assembly.chat);
                    const result = await assemblePrompt(assembly.host, {
                        chatAdditonalTokens: 3,
                        continue: false,
                        generationId: "required-overflow",
                        stageTimings: { stage1Duration: 0, stage2Duration: 0 },
                    });
                    expect(result).toMatchObject({
                        type: "alert",
                        error: expect.stringContaining("required memory pages"),
                    });
                    if (result.type !== "alert") throw new Error(JSON.stringify(result));
                    expect(result.error).toContain("Gate scene (");
                    expect(result.error).toContain("Binding charter (");
                    expect(result.error).toContain(`over the limit of ${requiredCap === 1 ? 1 : 500}`);
                    expect(assembly.chat).toEqual(before);
                    expect(assembly.recordGap).not.toHaveBeenCalled();
                }
            }
        });

        it("drops only active unsuppressed coverage, retaining the assistant window and an older continue target", async () => {
            const messages: Entry[] = Array.from({ length: 6 }, (_, i) => [
                { chatId: `u${i + 1}`, data: `User ${i + 1}`, role: "user" as const },
                { chatId: `a${i + 1}`, data: `Reply ${i + 1}`, role: "char" as const },
            ]).flat();
            messages.push({ chatId: "u7", data: "Now" });
            const records = anchored(
                stored([
                    event("active", ["u1", "a1"]),
                    event("stale", ["u2", "a2"], { status: "stale" }),
                    event("retracted", ["u3", "a3"], { status: "retracted" }),
                    event("suppressed", ["u4", "a4"], { suppressed: true }),
                    event("recent", ["u5", "a5", "u6", "a6"]),
                ]),
                messages,
            );
            for (const { continued, preview } of [
                { continued: false, preview: false },
                { continued: true, preview: false },
                { continued: false, preview: true },
            ]) {
                const assembly = structuredAssembly({
                    messages,
                    records,
                    preview,
                    maxContext: 6000,
                    settings: { windowTurns: 2 },
                });
                const result = await assembly.run(continued ? { continue: true, continueMessageId: "a1" } : {});
                expect(rawIds(result.formated)).toEqual([
                    ...(continued ? ["a1"] : []),
                    "u2",
                    "a2",
                    "u3",
                    "a3",
                    "u4",
                    "a4",
                    "u5",
                    "a5",
                    "u6",
                    "a6",
                    "u7",
                ]);
                expect(result.formated[0]).toMatchObject({ role: "system", memo: "supaMemory" });
                expect(result.formated[0].content).toContain("[m:flow:active]");
                expect(result.report.memory).toMatchObject({ kind: "structuredMemory", coverage: "covered" });
                expect(assembly.confirmGap).not.toHaveBeenCalled();
            }
        });

        it("reports an empty card as a gap only when its dropped covered history has text or media, without asking", async () => {
            for (const [data, coverage] of [
                ["A remembered promise", "gap"],
                ["{{inlayeddata::pic}}", "gap"],
                ["   ", "covered"],
            ] as const) {
                const messages: Entry[] = [
                    { chatId: "old", role: "user", data },
                    { chatId: "a0", role: "char", data: "Old reply" },
                    { chatId: "u1", role: "user", data: "Recent user" },
                    { chatId: "a1", role: "char", data: "Recent reply" },
                    { chatId: "now", role: "user", data: "Now" },
                ];
                const assembly = structuredAssembly({
                    greeting: "",
                    messages,
                    records: anchored(stored([event("past", ["old"])]), messages),
                    settings: { flowEvents: 0, laneTargets: { pages: 0, events: 0, evidence: 0, threads: 0 } },
                    maxContext: 6000,
                    gapConfirmTokens: 0,
                    readInlay: async () => ({ type: "image", data: "data:image/png;base64,AA==", width: 1, height: 1 }),
                });
                const { report, formated } = await assembly.run();
                expect(rawIds(formated)).not.toContain("old");
                expect(rawIds(formated)).toEqual(["a0", "u1", "a1", "now"]);
                expect(report.memory, data).toMatchObject({ kind: "structuredMemory", coverage, tokens: 0, items: [] });
                expect(report.memory!.stages).toContainEqual({ stage: "card", reason: "empty" });
                expect(report.memory!.stages!.some(({ stage }) => stage === "gap")).toBe(false);
                expect(assembly.confirmGap).not.toHaveBeenCalled();
                expect(assembly.recordGap).not.toHaveBeenCalled();
            }
        });

        it("reports only the memory budget reduction for Structured Memory", async () => {
            const assembly = structuredAssembly({ messages: fiveMessages, maxContext: 1000 });
            Object.assign(assembly.host.db.hypaV3Presets[0].settings, {
                budgetMode: "tokens",
                memoryBudgetTokens: 900,
                lookaheadHeadroomTokens: 800,
                extraSummarizationTokens: 700,
            });
            const { report } = await assembly.run();
            // The prompt budget is 1000 - 10; memory is capped at half of it.
            expect(report.memory!.budget).toBe(495);
            expect(report.memory!.budgetReduced).toEqual([{ field: "memory", configured: 900, applied: 495 }]);
        });

        it("trims uncovered history oldest first, without charging examples or the marker to the gap or emitting an empty card", async () => {
            for (const maxContext of [175, 130]) {
                const assembly = structuredAssembly({
                    messages: fiveMessages,
                    maxContext,
                    examples: "<START>\nUser: Example user\nCounter: Example reply",
                    promptSettings: { trimStartNewChat: false },
                });
                const result = await assembly.run();
                // Allowance 50 + response 10 + greeting 6 + five messages at 23 = 181.
                // The marker comes from the allowance. Dropping it frees 21; at 130 the greeting
                // and oldest pair must also go: 6 + 23 + 23 = 52 gap tokens.
                expect(result.texts).toEqual(
                    maxContext === 175
                        ? ["Hi!", ...fiveMessages.map((m) => m.data)]
                        : fiveMessages.slice(2).map((m) => m.data),
                );
                expect(result.formated.some((m) => m.memo === "supaMemory")).toBe(false);
                expect(result.report.memory).toMatchObject({
                    kind: "structuredMemory",
                    tokens: 0,
                    items: [],
                    coverage: maxContext === 175 ? "covered" : "gap",
                });
                expect(assembly.confirmGap.mock.calls).toEqual(
                    maxContext === 175 ? [] : [[{ gapTokens: 52, plannedCalls: 2 }]],
                );
                expect(assembly.recordGap).not.toHaveBeenCalled();
            }
        });

        it("leaves a held send without a gap question or task and explains the hold in its reply receipt", async () => {
            const assembly = structuredAssembly({
                messages: fiveMessages,
                maxContext: 150,
                gapConfirmTokens: 0,
                records: { ...stored([]), adoptionHeld: true },
                settings: { cadence: "everyTurn" },
            });
            const result = await assemblePrompt(assembly.host, {
                chatAdditonalTokens: 3,
                continue: false,
                generationId: "held",
                stageTimings: { stage1Duration: 0, stage2Duration: 0 },
            });
            expect(result.type).toBe("prompt");
            expect(result).not.toHaveProperty("memoryTask");
            expect(result).toMatchObject({
                generationInfo: { memory: { state: "notAutomatic", reason: "awaitingAdoption" } },
            });
            expect(assembly.confirmGap).not.toHaveBeenCalled();
            expect(assembly.recordGap).not.toHaveBeenCalled();
        });

        it("offers a gap only above the threshold with recordable work, and previews select without asking or writing", async () => {
            for (const row of [
                { threshold: 51, preview: false, status: undefined, asks: true },
                { threshold: 52, preview: false, status: undefined, asks: false },
                { threshold: 51, preview: true, status: undefined, asks: false },
                { threshold: 51, preview: false, status: "stale" as const, asks: false },
                { threshold: 51, preview: false, status: "retracted" as const, asks: false },
                { threshold: 51, preview: false, status: "suppressed" as const, asks: false },
            ]) {
                const records = stored(
                    row.status
                        ? [
                              event(
                                  "recorded",
                                  ["m1", "m2", "m3", "m4"],
                                  row.status === "suppressed" ? { suppressed: true } : { status: row.status },
                              ),
                          ]
                        : [],
                );
                const before = structuredClone(records);
                const assembly = structuredAssembly({
                    messages: fiveMessages,
                    maxContext: 150,
                    records,
                    preview: row.preview,
                    gapConfirmTokens: row.threshold,
                });
                const result = await assembly.run();
                expect(result.texts, JSON.stringify(row)).toEqual(fiveMessages.slice(2).map((m) => m.data));
                expect(result.report.memory).toMatchObject({ coverage: "gap", confirmedThrough: "m4" });
                expect(assembly.confirmGap).toHaveBeenCalledTimes(row.asks ? 1 : 0);
                expect(assembly.recordGap).not.toHaveBeenCalled();
                expect(records).toEqual(before);
            }
        });

        it("fails instead of dropping the raw window or continue target at selection and after editRequest", async () => {
            for (const row of [
                { continued: false, late: false, maxContext: 128, padding: 0 },
                { continued: true, late: false, maxContext: 140, padding: 0 },
                { continued: false, late: true, maxContext: 400, padding: 330 },
                { continued: true, late: true, maxContext: 400, padding: 310 },
            ]) {
                const assembly = structuredAssembly({
                    messages: fiveMessages,
                    maxContext: row.maxContext,
                    editRequest: row.late
                        ? (entries) => [
                              ...entries.map((entry) => ({ ...entry, removable: true })),
                              { role: "system", content: "x".repeat(row.padding), removable: true },
                          ]
                        : undefined,
                });
                const result = await assemblePrompt(assembly.host, {
                    chatAdditonalTokens: 3,
                    continue: row.continued,
                    ...(row.continued ? { continueMessageId: "m2" } : {}),
                    generationId: "protected-window",
                    stageTimings: { stage1Duration: 0, stage2Duration: 0 },
                });
                expect(result, JSON.stringify(row)).toMatchObject({
                    type: "error",
                    error: expect.stringContaining("The minimum required token is greater than the max context size"),
                });
                if (result.type === "error") expect(result.error.includes("At token rechecking")).toBe(row.late);
                expect(assembly.recordGap).not.toHaveBeenCalled();
            }
        });

        it("places volatile memory immediately before the latest user despite a chat range, keeping stable memory in its card", async () => {
            for (const apart of [false, true]) {
                const assembly = structuredAssembly({
                    messages: fiveMessages,
                    maxContext: 4000,
                    records: anchored(
                        stored(
                            [event("past", ["m1", "m2"])],
                            [{ id: "open", title: "Find the key", who: [], state: "open" }],
                        ),
                        fiveMessages,
                    ),
                    settings: { volatileBeforeLastUser: apart },
                    template: [{ type: "memory" }, { type: "chat", rangeStart: -1, rangeEnd: "end" }],
                });
                const result = await assembly.run();
                expect(result.texts.at(-1)).toBe(fiveMessages[4].data);
                expect(result.formated[0].memo).toBe("supaMemory");
                expect(result.texts[0]).toContain("[m:flow:past]");
                expect(result.formated).toHaveLength(apart ? 3 : 2);
                expect(result.texts[apart ? 1 : 0]).toContain("[m:open] Find the key");
                if (apart) {
                    expect(result.texts[0]).not.toContain("[m:open]");
                    expect(result.texts[1]).not.toContain("[m:flow:past]");
                }
                expect(result.report.memory!.items).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ id: "past", lane: "flow", verified: true }),
                        expect.objectContaining({ id: "open", lane: "threads", verified: true }),
                    ]),
                );
            }
        });

        it("verifies each manifest tag after editRequest and demotes coverage when only one item is lost", async () => {
            for (const loseTag of [false, true]) {
                const assembly = structuredAssembly({
                    messages: fiveMessages,
                    maxContext: 4000,
                    records: anchored(
                        stored(
                            [event("past", ["m1", "m2"])],
                            [{ id: "open", title: "Find the key", who: [], state: "open" }],
                        ),
                        fiveMessages,
                    ),
                    editRequest: (entries) =>
                        entries.map((entry) => ({
                            ...entry,
                            content: entry.content.replace("[m:open]", loseTag ? "[removed]" : "[m:open]"),
                        })),
                });
                const { report } = await assembly.run();
                expect(report.memory).toMatchObject({
                    kind: "structuredMemory",
                    coverage: loseTag ? "unknown" : "covered",
                    confirmedThrough: "m4",
                    writer: { state: "pending" },
                    items: [
                        { id: "past", kind: "event", lane: "flow", verified: true },
                        { id: "open", kind: "thread", lane: "threads", verified: !loseTag },
                    ],
                    lanes: [
                        { lane: "required", target: 1500, spent: 0 },
                        {
                            lane: "flow",
                            target: Number.MAX_SAFE_INTEGER,
                            spent: "[m:flow:past] 2 turns ago: past".length + 3,
                        },
                        { lane: "pages", target: 0, spent: 0 },
                        { lane: "events", target: 0, spent: 0 },
                        { lane: "evidence", target: 0, spent: 0 },
                        { lane: "threads", target: 300, spent: "[m:open] Find the key (open)".length + 3 },
                    ],
                    stages: [
                        { stage: "window", reason: "chosen" },
                        { stage: "lanes", reason: "filled" },
                        { stage: "card", reason: loseTag ? "partial" : "verified" },
                        { stage: "writer", reason: "due" },
                    ],
                });
            }
        });

        it("caps excluded records with the worst reasons first and preserves the total", async () => {
            const irrelevant = Array.from({ length: CONTEXT_MEMORY_EXCLUDED + 3 }, (_, i) =>
                event(`irrelevant-${i}`, []),
            );
            const assembly = structuredAssembly({
                messages: fiveMessages,
                maxContext: 4000,
                records: stored(
                    [...irrelevant, event("never", [], { suppressed: true }), event("stale", [], { status: "stale" })],
                    [{ id: "expensive", title: "x".repeat(3000), who: [], state: "open" }],
                ),
            });
            const { report } = await assembly.run();
            expect(report.memory!.excludedTotal).toBe(CONTEXT_MEMORY_EXCLUDED + 6);
            expect(report.memory!.excluded).toEqual([
                { id: "stale", kind: "event", lane: "events", reason: "stale" },
                { id: "never", kind: "event", lane: "events", reason: "never" },
                { id: "expensive", kind: "thread", lane: "threads", reason: "budget" },
                ...irrelevant
                    .slice(0, CONTEXT_MEMORY_EXCLUDED - 3)
                    .map(({ id }) => ({ id, kind: "event", lane: "events", reason: "not-relevant" })),
            ]);
        });

        it("keeps raw history ahead of every legacy flag and is configured with all of them off", async () => {
            const messages = [
                { chatId: "u1", data: "User one", role: "user" as const },
                { chatId: "a1", data: "Reply one", role: "char" as const },
                { chatId: "u2", data: "User two", role: "user" as const },
                { chatId: "a2", data: "Reply two", role: "char" as const },
            ];
            for (const legacy of [true, false]) {
                const { run, chat } = contextAssembly({
                    messages,
                    hypaV3: true,
                    maxContext: 2000,
                    db: {
                        memoryAlgorithmType: "structuredMemory",
                        hanuraiEnable: legacy,
                        hypav2: legacy,
                        hypaV3: legacy,
                        hypaMemory: legacy,
                        supaModelType: legacy ? "subModel" : "none",
                    },
                });
                chat.hypaV3Data = {
                    summaries: [{ text: "Stored memory card", chatMemos: ["u1", "a1"], isImportant: false }],
                };
                chat.supaMemoryData = "Stored Supa card";
                const { texts } = await run();
                for (const message of messages) expect(texts, String(legacy)).toContain(message.data);
                expect(texts.join("\n")).not.toContain("Stored memory card");
                expect(texts.join("\n")).not.toContain("Stored Supa card");
                expect(texts.join("\n")).not.toContain("<Past Events Summary>");
            }
            // With memory off on this character, configured memory offers the trim decision.
            const { run, host } = contextAssembly({
                messages: messages.map((message) => ({ ...message, data: message.data.repeat(8) })),
                maxContext: 180,
                db: { memoryAlgorithmType: "structuredMemory" },
            });
            const confirm = vi.fn(async () => "trim" as const);
            host.memoryTrim.confirm = confirm;
            await run();
            expect(confirm).toHaveBeenCalledTimes(1);
        });
    });

    it("attributes a template prompt with full history by section and records the trim ledger", async () => {
        const { run, chat, counts } = contextAssembly({
            template: [plain("main", "MAIN"), plain("globalNote", "NOTE!"), plain("normal", "P"), CHAT_CARD],
            promptSettings: { trimStartNewChat: false },
            messages: [
                { chatId: "u1", data: "hello" },
                { chatId: "c1", data: "hey there", role: "char" },
                { chatId: "u2", data: "ok" },
            ],
        });
        const { report, texts } = await run();
        // The three system cards merge into one entry (two "\n\n" joins: 19 counted, 17 sent); the
        // new-chat marker is uncounted when pushed and 21 in the recheck.
        expect(texts).toEqual(["MAIN\n\nNOTE!\n\nP", "[Start a new chat]", "Hi!", "hello", "hey there", "ok"]);
        const expected: ContextReport = {
            ...fixed(chat),
            input: 17 + 21 + 6 + 8 + 12 + 5,
            sections: [
                { kind: "main", tokens: 7 },
                { kind: "globalNote", tokens: 8 },
                { kind: "plain", tokens: 4 },
                { kind: "history", tokens: 6 + 8 + 12 + 5 },
            ],
            adjustment: 21 - 2,
            attributionExact: true,
            history: { total: 4, kept: 4, totalUser: 2, keptUser: 2, droppedTokens: 0 },
            trim: {
                // 400 − (10 + 50 + 19 cards + 31 history)
                headroom: 290,
                queue: [
                    { tokens: NEW_CHAT_TOKENS, kind: "marker", user: false },
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 8, kind: "message", user: true },
                    { tokens: 12, kind: "message", user: false },
                    { tokens: 5, kind: "message", user: true },
                ],
                perMessage: 3,
            },
        };
        expect(report).toEqual(expected);
        // No new token work: the three cards, the greeting, three messages, and the six-entry recheck.
        expect(counts).toHaveBeenCalledTimes(3 + 1 + 3 + 6);
    });

    it("keeps the trim loop's order in the queue (examples, the marker, then messages) and counts what it dropped", async () => {
        const examples = "<START>\n{{user}}: ex u\n{{char}}: ex c";
        const messages: Entry[] = [
            { chatId: "m1", data: "a".repeat(20) },
            { chatId: "m2", data: "b".repeat(20), role: "char" },
            { chatId: "m3", data: "c" },
        ];
        // The ledger: 60 + 21 (example marker) + 7 + 7 + 0 (marker) + 6 + 23 + 23 + 4 = 151.
        const partial = contextAssembly({
            examples,
            messages,
            maxContext: 140,
            promptSettings: { trimStartNewChat: false },
        });
        const a = await partial.run();
        expect(a.texts).toEqual(["ex u", "ex c", "[Start a new chat]", "Hi!", "a".repeat(20), "b".repeat(20), "c"]);
        expect(a.report).toEqual({
            ...fixed(partial.chat, 140),
            input: 7 + 7 + 21 + 6 + 23 + 23 + 4,
            sections: [
                { kind: "examples", tokens: 14 },
                { kind: "history", tokens: 56 },
            ],
            adjustment: 21,
            attributionExact: true,
            history: { total: 4, kept: 4, totalUser: 2, keptUser: 2, droppedTokens: 0 },
            trim: {
                headroom: 140 - (151 - 21),
                queue: [
                    { tokens: 7, kind: "example", user: false },
                    { tokens: 7, kind: "example", user: false },
                    { tokens: NEW_CHAT_TOKENS, kind: "marker", user: false },
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 23, kind: "message", user: true },
                    { tokens: 23, kind: "message", user: false },
                    { tokens: 4, kind: "message", user: true },
                ],
                perMessage: 3,
            },
        });
        // Three examples, the greeting, three messages, one trim drop, and the seven-entry recheck:
        // the marker's queue count comes from that recheck, not from a count of its own.
        expect(partial.counts).toHaveBeenCalledTimes(3 + 1 + 3 + 1 + 7);

        // 151 → drop the example marker, both examples, the marker (21), and the greeting: 89 ≤ 92.
        const deep = contextAssembly({
            examples,
            messages,
            maxContext: 92,
            promptSettings: { trimStartNewChat: false },
        });
        const b = await deep.run();
        expect(b.texts).toEqual(["a".repeat(20), "b".repeat(20), "c"]);
        expect(b.report).toEqual({
            ...fixed(deep.chat, 92),
            input: 50,
            sections: [{ kind: "history", tokens: 50 }],
            adjustment: 0,
            attributionExact: true,
            history: { total: 4, kept: 3, totalUser: 2, keptUser: 2, droppedTokens: 6 },
            trim: {
                headroom: 3,
                queue: [
                    { tokens: 23, kind: "message", user: true },
                    { tokens: 23, kind: "message", user: false },
                    { tokens: 4, kind: "message", user: true },
                ],
                perMessage: 3,
            },
        });
        expect(deep.counts).toHaveBeenCalledTimes(3 + 1 + 3 + 5 + 3);

        // The queue holds at most eight entries, the greeting first.
        const long = contextAssembly({
            messages: Array.from({ length: 12 }, (_, i) => ({
                chatId: `m${i}`,
                data: "x",
                role: i % 2 ? "char" : "user",
            })),
        });
        const c = await long.run();
        expect(c.report.trim?.queue).toEqual([
            { tokens: 6, kind: "message", user: false },
            ...Array.from({ length: 7 }, (_, i) => ({ tokens: 4, kind: "message", user: i % 2 === 0 })),
        ]);
        expect(c.report.history).toEqual({ total: 13, kept: 13, totalUser: 6, keptUser: 6, droppedTokens: 0 });
    });

    it("counts a message emitted by overlapping chat ranges once; the duplicate goes to the adjustment", async () => {
        const { run, chat } = contextAssembly({
            template: [CHAT_CARD, { type: "chat", rangeStart: -1, rangeEnd: "end" }],
            messages: [
                { chatId: "u1", data: "hello" },
                { chatId: "c1", data: "yo", role: "char" },
            ],
        });
        const { report, formated, texts } = await run();
        expect(texts).toEqual(["Hi!", "hello", "yo", "yo"]);
        expect(formated[2]).toBe(formated[3]);
        expect(report).toEqual({
            ...fixed(chat),
            input: 6 + 8 + 5 + 5,
            sections: [{ kind: "history", tokens: 19 }],
            adjustment: 5,
            attributionExact: true,
            history: { total: 3, kept: 3, totalUser: 1, keptUser: 1, droppedTokens: 0 },
            trim: {
                headroom: 400 - (60 + 19),
                queue: [
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 8, kind: "message", user: true },
                    { tokens: 5, kind: "message", user: false },
                ],
                perMessage: 3,
            },
        });
    });

    it("merges a system entry into a copy, so another chat range's occurrence of that entry keeps its text", async () => {
        const separator: PromptItem = { type: "plain", type2: "normal", text: "--", role: "user" };
        const { run } = contextAssembly({
            template: [CHAT_CARD, separator, CHAT_CARD],
            messages: [
                { chatId: "u1", data: "hello" },
                { chatId: "c1", data: "yo", role: "char" },
            ],
            promptSettings: { sendChatAsSystem: true },
        });
        const { texts } = await run();
        const range = "assistant: Hi!\n\nuser: hello\n\nassistant: yo";
        expect(texts).toEqual([range, "--", range]);
    });

    it.each([760, 720, 660])(
        "counts every removed occurrence of overlapping history and keeps the entries that fit in %i tokens",
        async (promptBudget) => {
            // The recheck keeps the response budget (`maxResponse` 10) free.
            const maxContext = promptBudget + 10;
            const depth = "d".repeat(650);
            const { run, host } = contextAssembly({
                template: [CHAT_CARD, { type: "chat", rangeStart: 1, rangeEnd: 2 }],
                messages: [
                    { chatId: "old", data: "x".repeat(50) },
                    { chatId: "kept", data: "keep" },
                ],
                maxContext,
                character: { depth_prompt: { depth: 0, prompt: depth } },
            });
            // Before rechecking: greeting 6 + old 53 + kept 7 + depth 653 + old again 53 = 772.
            // Clearing the greeting and shared old entry removes 6 + 2 * 53, leaving exactly 660.
            const { generationInfo, formated, texts } = await run();
            expect(texts).toEqual(["keep", depth]);
            expect(generationInfo.inputTokens).toBe(660);
            expect(generationInfo.inputTokens).toBe(await host.tokenizer.tokenizeChats(formated));
        },
    );

    it("sendChatAsSystem: one merged entry keeps every source; a recheck removal of it drops them all", async () => {
        const messages: Entry[] = [
            { chatId: "u1", data: "hello" },
            { chatId: "c1", data: "yo", role: "char" },
        ];
        const merged = contextAssembly({ messages, promptSettings: { sendChatAsSystem: true } });
        const a = await merged.run();
        // "assistant: Hi!" + "\n\n" + "user: hello" + "\n\n" + "assistant: yo" = 42 characters.
        expect(a.texts).toEqual(["assistant: Hi!\n\nuser: hello\n\nassistant: yo"]);
        expect(a.report).toEqual({
            ...fixed(merged.chat),
            input: 45,
            sections: [{ kind: "history", tokens: 19 }],
            adjustment: 26,
            attributionExact: true,
            history: { total: 3, kept: 3, totalUser: 1, keptUser: 1, droppedTokens: 0 },
            trim: {
                headroom: 400 - (60 + 19),
                queue: [
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 8, kind: "message", user: true },
                    { tokens: 5, kind: "message", user: false },
                ],
                perMessage: 3,
            },
        });

        // A late depth prompt (uncounted, 403) pushes the recheck over 420: the merged entry goes.
        const removed = contextAssembly({
            messages,
            maxContext: 420,
            promptSettings: { sendChatAsSystem: true },
            character: { depth_prompt: { depth: 0, prompt: "d".repeat(400) } },
        });
        const b = await removed.run();
        expect(b.texts).toEqual(["d".repeat(400)]);
        expect(b.report).toEqual({
            ...fixed(removed.chat, 420),
            input: 403,
            sections: [],
            adjustment: 403,
            attributionExact: true,
            history: { total: 3, kept: 0, totalUser: 1, keptUser: 0, droppedTokens: 19 },
        });
    });

    it("a recheck removal of traced messages leaves kept history; an untraced part makes it approximate", async () => {
        const traced = contextAssembly({
            messages: [
                { chatId: "old", data: "x".repeat(50) },
                { chatId: "kept", data: "keep" },
            ],
            maxContext: 700,
            character: { depth_prompt: { depth: 0, prompt: "d".repeat(650) } },
        });
        const a = await traced.run();
        // 6 + 53 + 7 + 653 = 719 > 700: the greeting (6) and `old` (53) are cleared, in order.
        expect(a.texts).toEqual(["keep", "d".repeat(650)]);
        expect(a.report).toEqual({
            ...fixed(traced.chat, 700),
            input: 660,
            sections: [{ kind: "history", tokens: 7 }],
            adjustment: 653,
            attributionExact: true,
            history: { total: 3, kept: 1, totalUser: 2, keptUser: 1, droppedTokens: 59 },
            // No ledger: the queue's first entries are no longer in the prompt, so they cannot be
            // displaced again.
        });

        // A depth lore entry (no source) merged into systemized history, then removed by the recheck.
        const untraced = contextAssembly({
            messages: [{ chatId: "u1", data: "hello" }],
            maxContext: 420,
            promptSettings: { sendChatAsSystem: true },
            character: { depth_prompt: { depth: 0, prompt: "d".repeat(400) } },
            lore: [
                {
                    depth: 1,
                    pos: "depth",
                    prompt: "LORE",
                    role: "system",
                    order: 0,
                    tokens: 4,
                    priority: 0,
                    source: "lore",
                    inject: null,
                },
            ],
        });
        const b = await untraced.run();
        expect(b.texts).toEqual(["d".repeat(400)]);
        expect(b.report).toEqual({
            ...fixed(untraced.chat, 420),
            lore: { ...fixed(untraced.chat).lore, active: 1 },
            input: 403,
            sections: [{ kind: "lorebook", tokens: 7 }],
            adjustment: 396,
            attributionExact: false,
            history: { total: 2, kept: 0, totalUser: 1, keptUser: 0, droppedTokens: 14 },
        });
    });

    it("an editRequest that changes the list makes attribution approximate and traces kept history by identity, id, then text", async () => {
        const messages: Entry[] = [
            { chatId: "a", data: "ok" },
            { chatId: "b", data: "ok" },
        ];
        const copy = (entry: OpenAIChat): OpenAIChat => JSON.parse(JSON.stringify(entry));
        const hook = async (editRequest: Options["editRequest"]) => {
            const assembly = contextAssembly({ messages, editRequest });
            return { ...(await assembly.run()), chat: assembly.chat };
        };
        const base = (chat: Chat) => ({ ...fixed(chat), attributionExact: false });
        const allKept = { total: 3, kept: 3, totalUser: 2, keptUser: 2, droppedTokens: 0 };
        const queue = [
            { tokens: 6, kind: "message" as const, user: false },
            { tokens: 5, kind: "message" as const, user: true },
            { tokens: 5, kind: "message" as const, user: true },
        ];

        // A deletion: the deleted message is not kept, and the ledger is gone with it.
        const deleted = await hook((list) => list.filter((entry) => entry.memo !== "a"));
        expect(deleted.texts).toEqual(["Hi!", "ok"]);
        expect(deleted.report).toEqual({
            ...base(deleted.chat),
            input: 11,
            sections: [{ kind: "history", tokens: 11 }],
            adjustment: 0,
            history: { total: 3, kept: 2, totalUser: 2, keptUser: 1, droppedTokens: 5 },
        });

        // A reorder of two equal texts: each entry keeps its own source (traced by identity).
        const reversed = await hook((list) => [...list].reverse());
        expect(reversed.texts).toEqual(["ok", "ok", "Hi!"]);
        expect(reversed.report).toEqual({
            ...base(reversed.chat),
            input: 16,
            sections: [{ kind: "history", tokens: 16 }],
            adjustment: 0,
            history: allKept,
            trim: { headroom: 400 - 76, queue, perMessage: 3 },
        });

        // Two copies of `b` in place of `a` and `b`: one stored message is kept, by its id.
        const doubled = await hook((list) => [list[0], copy(list[2]), copy(list[2])]);
        expect(doubled.report).toEqual({
            ...base(doubled.chat),
            input: 16,
            sections: [{ kind: "history", tokens: 11 }],
            adjustment: 5,
            history: { total: 3, kept: 2, totalUser: 2, keptUser: 1, droppedTokens: 5 },
        });

        // An in-place rewrite, and a name-only change: the same objects, no longer exact.
        const rewritten = await hook((list) => {
            list[1].content = "changed";
            return list;
        });
        expect(rewritten.texts).toEqual(["Hi!", "changed", "ok"]);
        expect(rewritten.report).toEqual({
            ...base(rewritten.chat),
            input: 6 + 10 + 5,
            sections: [{ kind: "history", tokens: 16 }],
            adjustment: 5,
            history: allKept,
            trim: { headroom: 400 - 76, queue, perMessage: 3 },
        });
        const renamed = await hook((list) => {
            list[1].name = "someone";
            return list;
        });
        expect(renamed.report).toMatchObject({ attributionExact: false, input: 16, history: allKept });

        // Copies of every entry (a Lua hook's round trip): the ids and the greeting's text trace them.
        const roundTrip = await hook((list) => list.map(copy));
        expect(roundTrip.report).toEqual({
            ...base(roundTrip.chat),
            input: 16,
            sections: [{ kind: "history", tokens: 16 }],
            adjustment: 0,
            history: allKept,
            trim: { headroom: 400 - 76, queue, perMessage: 3 },
        });

        // An entry with no source in place of both messages.
        const replaced = await hook((list) => [list[0], { role: "system", content: "injected" }]);
        expect(replaced.report).toEqual({
            ...base(replaced.chat),
            input: 6 + 11,
            sections: [{ kind: "history", tokens: 6 }],
            adjustment: 11,
            history: { total: 3, kept: 1, totalUser: 2, keptUser: 0, droppedTokens: 10 },
        });

        // The same list back: exact.
        const same = await hook((list) => list);
        expect(same.report).toMatchObject({ attributionExact: true, history: allKept });
    });

    it("the legacy path maps the main prompt and global note to sections and keeps lastChat in history", async () => {
        const { run, chat } = contextAssembly({
            template: null,
            db: { mainPrompt: "MAIN", globalNote: "NOTE!" },
            messages: [
                { chatId: "u1", data: "hello" },
                { chatId: "c1", data: "yo", role: "char" },
            ],
        });
        const { report, texts } = await run();
        expect(texts).toEqual(["MAIN", "Hi!", "hello", "yo", "NOTE!"]);
        expect(report).toEqual({
            ...fixed(chat),
            input: 7 + 6 + 8 + 5 + 8,
            // The empty description is counted (3) and then dropped from the prompt.
            sections: [
                { kind: "main", tokens: 7 },
                { kind: "globalNote", tokens: 8 },
                { kind: "description", tokens: 3 },
                { kind: "history", tokens: 19 },
            ],
            adjustment: -3,
            attributionExact: true,
            history: { total: 3, kept: 3, totalUser: 1, keptUser: 1, droppedTokens: 0 },
            trim: {
                headroom: 400 - (60 + 7 + 8 + 3 + 19),
                queue: [
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 8, kind: "message", user: true },
                    { tokens: 5, kind: "message", user: false },
                ],
                perMessage: 3,
            },
        });
    });

    it("assembles without a template when a history reset leaves no greeting, marker, examples, or eligible messages", async () => {
        const { run } = contextAssembly({
            template: null,
            examples: "",
            character: { utilityBot: false },
            promptSettings: { trimStartNewChat: true },
            messages: [{ chatId: "reset", data: "discard this and the greeting", disabled: "allBefore" }],
            db: { mainPrompt: "MAIN" },
        });

        const { texts } = await run();
        expect(texts).toEqual(["MAIN"]);
    });

    it("a greeting index past the alternate greetings (one deleted after the chat chose it) sends the first message", async () => {
        const { run, chat } = contextAssembly({
            template: [CHAT_CARD],
            promptSettings: { trimStartNewChat: true },
            character: { alternateGreetings: ["Alt"] },
            messages: [{ chatId: "u1", data: "hello" }],
        });
        chat.fmIndex = 3;

        const { texts } = await run();
        expect(texts).toEqual(["Hi!", "hello"]);
    });

    it("a continue records its target as the reply prefix and leaves that message out of the digest", async () => {
        const { run, chat } = contextAssembly({
            messages: [
                { chatId: "u1", data: "hello" },
                { chatId: "c1", data: "yo", role: "char" },
            ],
        });
        const without = (id: string) => historyDigest(chat.message.filter((message) => message.chatId !== id));
        const last = await run({ continue: true, continueMessageId: "c1" });
        expect(last.texts).toEqual(["Hi!", "hello", "yo", "[Continue the last response]"]);
        expect(last.report).toEqual({
            ...fixed(chat),
            historyDigest: without("c1"),
            input: 6 + 8 + 5 + 31,
            sections: [{ kind: "history", tokens: 19 }],
            adjustment: 31,
            attributionExact: true,
            history: { total: 3, kept: 3, totalUser: 1, keptUser: 1, droppedTokens: 0 },
            trim: {
                headroom: 400 - (60 + 19),
                queue: [
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 8, kind: "message", user: true },
                    { tokens: 5, kind: "message", user: false },
                ],
                replyPrefix: { messageId: "c1", tokens: 5 },
                perMessage: 3,
            },
        });
        expect(last.report.historyDigest).not.toBe(historyDigest(chat.message));

        // An explicit target that is not the last message.
        const explicit = await run({ continue: true, continueMessageId: "u1" });
        expect(explicit.report.trim?.replyPrefix).toEqual({ messageId: "u1", tokens: 8 });
        expect(explicit.report.historyDigest).toBe(without("u1"));

        // A target no message has: no prefix, the whole history in the digest.
        const unknown = await run({ continue: true, continueMessageId: "gone" });
        expect(unknown.report.trim?.replyPrefix).toBeUndefined();
        expect(unknown.report.historyDigest).toBe(historyDigest(chat.message));

        // A plain send of the same chat.
        const plainSend = await run();
        expect(plainSend.report.trim?.replyPrefix).toBeUndefined();
        expect(plainSend.report.adjustment).toBe(0);
    });

    it("HypaV3 reports covered summaries as sent, and unknown coverage when the card is suppressed", async () => {
        const messages: Entry[] = [
            { chatId: "u1", data: "hello" },
            { chatId: "c1", data: "yo", role: "char" },
        ];
        // Without a task service the legacy count frees the response budget: the 79 counted
        // (`maxResponse` 10, assembly's allowance 50, the history 19) less 10 may grow past 400 less
        // the empty card it reserves (48) before the next send summarizes.
        const memoryBlock = (tokens: number, coverage: "covered" | "unknown") => ({
            kind: "hypaV3" as const,
            tokens,
            budget: 80, // floor(400 × 0.2)
            coverage,
            ...(coverage === "covered" ? { summarized: 0 } : {}),
            reserved: 48,
            summarizeIn: 400 - 48 - (79 - 10) + 1,
        });
        // No memory card: the empty summary card travels in the history, wrapped (23 + 45 + 24).
        const inline = contextAssembly({ messages, hypaV3: true });
        const a = await inline.run();
        expect(a.texts).toEqual([
            `<Previous Conversation>${EMPTY_SUMMARY_CARD}</Previous Conversation>`,
            "Hi!",
            "hello",
            "yo",
        ]);
        expect(a.report).toEqual({
            ...fixed(inline.chat),
            input: 95 + 19,
            sections: [
                { kind: "memory", tokens: 95 },
                { kind: "history", tokens: 19 },
            ],
            adjustment: 0,
            attributionExact: true,
            history: { total: 3, kept: 3, totalUser: 1, keptUser: 1, droppedTokens: 0 },
            memory: memoryBlock(95, "covered"),
        });

        // A memory card: the card as formatted.
        const card = contextAssembly({ messages, hypaV3: true, template: [{ type: "memory" }, CHAT_CARD] });
        const b = await card.run();
        expect(b.texts).toEqual([EMPTY_SUMMARY_CARD, "Hi!", "hello", "yo"]);
        expect(b.report).toMatchObject({
            input: 48 + 19,
            sections: [
                { kind: "memory", tokens: 48 },
                { kind: "history", tokens: 19 },
            ],
            memory: memoryBlock(48, "covered"),
        });

        // A memory card whose inner format leaves nothing: the summaries never reach the prompt.
        const suppressed = contextAssembly({
            messages,
            hypaV3: true,
            template: [{ type: "memory", innerFormat: " " }, CHAT_CARD],
        });
        const c = await suppressed.run();
        expect(c.texts).toEqual(["Hi!", "hello", "yo"]);
        expect(c.report).toEqual({
            ...fixed(suppressed.chat),
            input: 19,
            sections: [{ kind: "history", tokens: 19 }],
            adjustment: 0,
            attributionExact: true,
            history: { total: 3, kept: 3, totalUser: 1, keptUser: 1, droppedTokens: 0 },
            memory: memoryBlock(0, "unknown"),
        });
    });

    /** A preview's memory side with a task service: the HypaV3 step selects only. */
    const selectOnlyJob: AssemblyMemoryJob = {
        preview: true,
        input: false,
        tasks: true,
        sourceGeneration: () => undefined,
        readSource: () => null,
        blockingReason: () => null,
        confirmGap: async () => {
            throw new Error("A preview asks no gap question");
        },
        markStopped() {},
        acquireWriter: async () => {
            throw new Error("A select-only step takes no writer lease");
        },
        openRun: () => ({ update() {}, close() {}, registerStop: () => null }),
        taskInput: () => null,
    };
    /** Five 20-character messages after the greeting (23 tokens each). */
    const fiveMessages = Array.from({ length: 5 }, (_, i) => ({
        chatId: `m${i + 1}`,
        data: String.fromCharCode(97 + i).repeat(20),
        role: (i % 2 ? "char" : "user") as Message["role"],
    }));

    it("HypaV3 reports applied token budgets and includes reductions only when the preset does not fit", async () => {
        // C = 400, response = 10: half the prompt budget is 195. With extra = 200,
        // all headroom goes first, then extra falls to 195; memory independently falls to 195.
        for (const fits of [false, true]) {
            const preset = createHypaV3Preset(
                "Tokens",
                {
                    budgetMode: "tokens",
                    memoryBudgetTokens: fits ? 100 : 6000,
                    lookaheadHeadroomTokens: fits ? 50 : 4000,
                    extraSummarizationTokens: fits ? 25 : 200,
                    memoryTokensRatio: 0.01,
                    similarMemoryRatio: 0,
                },
                "tokens",
            );
            const { run } = contextAssembly({
                hypaV3: true,
                maxContext: 400,
                memoryJob: { ...selectOnlyJob, preview: false, input: true },
                template: [{ type: "memory" }, CHAT_CARD],
                messages: [{ chatId: "u1", data: "hello" }],
                db: { hypaV3Presets: [preset], hypaV3PresetId: preset.id },
            });
            const { report } = await run();
            expect(report.memory?.budget).toBe(fits ? 100 : 195);
            if (fits) {
                expect(report.memory).not.toHaveProperty("budgetReduced");
            } else {
                expect(report.memory?.budgetReduced).toEqual([
                    { field: "memory", configured: 6000, applied: 195 },
                    { field: "headroom", configured: 4000, applied: 0 },
                    { field: "extra", configured: 200, applied: 195 },
                ]);
            }
        }
    });

    it("HypaV3 reports a gap when a select-only step trims uncovered history", async () => {
        const { run, chat } = contextAssembly({
            hypaV3: true,
            maxContext: 200,
            memoryJob: selectOnlyJob,
            messages: fiveMessages,
        });
        const { report, texts } = await run();
        // The ledger keeps the response budget: it reaches the selection at 181 + 40 (the full
        // memory budget, as the empty card does not fit) = 221; the trim runs from 221 − 40 + 48 =
        // 229 and drops the greeting (6) and m1 (23) to 200, never the last three history entries.
        expect(texts).toEqual([
            `<Previous Conversation>${EMPTY_SUMMARY_CARD}</Previous Conversation>`,
            "b".repeat(20),
            "c".repeat(20),
            "d".repeat(20),
            "e".repeat(20),
        ]);
        expect(report).toEqual({
            ...fixed(chat, 200),
            input: 95 + 4 * 23,
            sections: [
                { kind: "memory", tokens: 95 },
                { kind: "history", tokens: 92 },
            ],
            adjustment: 0,
            attributionExact: true,
            history: { total: 6, kept: 4, totalUser: 3, keptUser: 2, droppedTokens: 29 },
            // No summary covers the two entries left out. The summarizer still counts them (181 is
            // past 200 less the empty card), so the next send summarizes. A preview builds no task
            // input: no lookahead point.
            memory: {
                kind: "hypaV3",
                tokens: 95,
                budget: 40,
                coverage: "gap",
                summarized: 0,
                reserved: 48,
                summarizeIn: 0,
            },
        });
    });

    it("HypaV3 defers a stored summary while the prompt fits, counts the greeting it covers (a null memo), and reports the lookahead point of an input job", async () => {
        const inputJob: AssemblyMemoryJob = {
            ...selectOnlyJob,
            preview: false,
            input: true,
            // A task input needs the history's source generation.
            sourceGeneration: () => 1,
            confirmGap: async () => {
                throw new Error("Nothing uncovered is left out");
            },
            taskInput: (part) => part as never,
        };
        const { run, chat } = contextAssembly({
            hypaV3: true,
            memoryJob: inputJob,
            template: [{ type: "memory" }, CHAT_CARD],
            messages: fiveMessages,
        });
        chat.hypaV3Data = { summaries: [{ text: "S", chatMemos: [null as never, "m1"], isImportant: false }] };
        const { report, texts } = await run();
        // A context of 400: 181 counted with the empty card (48) fits, so the summary of the greeting
        // and m1 waits and the prompt keeps them raw.
        expect(texts).toEqual([
            "<Past Events Summary>\n\n</Past Events Summary>",
            "Hi!",
            ...["a", "b", "c", "d", "e"].map((letter) => letter.repeat(20)),
        ]);
        // The 181 may grow past 400 − 48 before the summary comes in. A lookahead starts at the stored
        // coverage: 181 less the greeting and m1 (29) with the budget of 80 is 232, and it asks once its
        // first window (m2 alone before the three-message tail, 23) leaves its target, 400 × 0.85,
        // reached: at 363.
        expect(report.memory).toEqual({
            kind: "hypaV3",
            tokens: 48,
            budget: 80,
            coverage: "covered",
            summarized: 0,
            prepared: 2,
            reserved: 48,
            summarizeIn: 400 - 48 - 181 + 1,
            lookaheadIn: 340 + 23 - 232,
        });

        // A chat whose summaries must run inside the job: a task would refuse it, so no lookahead point.
        const blocked = contextAssembly({
            hypaV3: true,
            memoryJob: {
                ...inputJob,
                blockingReason: () => "requestTrigger",
                acquireWriter: async () => ({ release() {} }),
            },
            template: [{ type: "memory" }, CHAT_CARD],
            messages: fiveMessages,
        });
        blocked.chat.hypaV3Data = structuredClone(chat.hypaV3Data);
        const blockedReport = (await blocked.run()).report;
        expect(blockedReport.memory).toMatchObject({ prepared: 2, summarizeIn: 400 - 48 - 181 + 1 });
        expect(blockedReport.memory!.lookaheadIn).toBeUndefined();
    });

    it("HypaV3 never counts a legacy message without an id as covered by the greeting's empty memo", async () => {
        const { run, chat } = contextAssembly({
            hypaV3: true,
            template: [{ type: "memory" }],
            messages: [
                { chatId: undefined as never, data: "legacy not summarized" },
                { chatId: "t", data: "tail", role: "char" },
            ],
        });
        // A summary of the greeting alone; the memory card is the whole prompt.
        chat.hypaV3Data = { summaries: [{ text: "greeting only", chatMemos: [null as never], isImportant: false }] };
        const { report } = await run();
        expect(report.history).toMatchObject({ total: 3, kept: 0 });
        expect(report.memory!.summarized).toBe(1);
    });

    it("history left blank by its scripts is not counted as left out unsummarized", async () => {
        const messages = Array.from({ length: 30 }, (_, i) => ({
            chatId: `m${i + 1}`,
            data: String.fromCharCode(97 + (i % 26)).repeat(20),
            role: (i % 2 ? "char" : "user") as Message["role"],
        }));
        // A blank greeting and a blank message in the raw tail: formatting drops both, and HypaV3 never
        // summarizes a blank entry, so the stored summaries start at m1.
        messages[25].data = "   ";
        const { run, chat } = contextAssembly({
            hypaV3: true,
            memoryJob: selectOnlyJob,
            template: [{ type: "memory" }, CHAT_CARD],
            greeting: "",
            messages,
        });
        chat.hypaV3Data = {
            summaries: Array.from({ length: 12 }, (_, k) => ({
                text: `S${k}`,
                chatMemos: k === 0 ? ["m1"] : [`m${2 * k}`, `m${2 * k + 1}`],
                isImportant: false,
            })),
        };
        const { report } = await run();
        // The deferral brings in the summaries through m19; m20 to m30 are sent but m26. Neither blank
        // entry counts, so everything left out is summarized.
        expect(report.history).toMatchObject({ total: 29, kept: 10, totalUser: 15, keptUser: 5 });
        expect(report.memory).toMatchObject({ coverage: "covered", summarized: 19 });
    });

    it("a message with media and no text still counts as history", async () => {
        const { run } = contextAssembly({
            readInlay: async () => ({ type: "image", data: "data:image/png;base64,AA==", width: 1, height: 1 }),
            messages: [
                { chatId: "a", data: "{{inlayeddata::pic}}", role: "char" },
                { chatId: "b", data: "   " },
                { chatId: "c", data: "tail", role: "char" },
            ],
        });
        // The inlay leaves the first message without text; the second is blank. The greeting, the
        // image message, and the tail are the history.
        const { report } = await run();
        expect(report.history).toMatchObject({ total: 3, kept: 3, totalUser: 0, keptUser: 0, droppedTokens: 0 });
    });

    it("HypaV3's summarize count is the summarizer's, not the formatted prompt's", async () => {
        // A short chat range and a late depth prompt change the prompt the report describes, not the
        // 181 the step counts (`maxResponse` 10, the allowance 50, the greeting 6, five messages 115).
        const assembled = (options: Partial<Options>) =>
            contextAssembly({
                hypaV3: true,
                memoryJob: selectOnlyJob,
                template: [{ type: "memory" }, CHAT_CARD],
                messages: fiveMessages,
                ...options,
            }).run();
        const whole = (await assembled({})).report;
        const ranged = (
            await assembled({ template: [{ type: "memory" }, { type: "chat", rangeStart: -1, rangeEnd: "end" }] })
        ).report;
        const depth = (await assembled({ character: { depth_prompt: { depth: 0, prompt: "d".repeat(100) } } })).report;
        expect(ranged.input).toBeLessThan(whole.input);
        expect(depth.input).toBeGreaterThan(whole.input);
        for (const report of [whole, ranged, depth]) {
            expect(report.memory).toMatchObject({ reserved: 48, summarizeIn: 400 - 48 - 181 + 1 });
        }
    });

    it("a blocking HypaV3 step's summarize count starts after the windows it summarized", async () => {
        const assembly = contextAssembly({
            hypaV3: true,
            maxContext: 220,
            memoryJob: {
                ...selectOnlyJob,
                preview: false,
                input: true,
                blockingReason: () => "requestTrigger",
                acquireWriter: async () => ({ release() {} }),
                // The window's sources are checked against the chat as stored.
                readSource: () => ({ messages: chat.message, fmIndex: chat.fmIndex, greeting: "Hi!" }),
            },
            template: [{ type: "memory" }, CHAT_CARD],
            messages: fiveMessages,
            request: async () => ({ type: "success", result: "Sum" }),
            storeMemory: true,
        });
        const { chat } = assembly;
        const { report } = await assembly.run();
        // 181 counted with the empty card (48) is over 220, so the full budget (44) is held (225):
        // the one window before the three-message tail (the greeting, m1, and m2: 52) brings it to
        // 173. The next send counts the 129 entries after it, which may grow to 220 − 44.
        expect(chat.hypaV3Data?.summaries).toHaveLength(1);
        expect(report.memory).toMatchObject({ summarized: 3, reserved: 44, summarizeIn: 220 - 44 - (181 - 52) + 1 });
    });

    it("a select-only HypaV3 step keeps the response budget free: it trims history the whole context would hold", async () => {
        const { run } = contextAssembly({
            hypaV3: true,
            maxContext: 220,
            memoryJob: selectOnlyJob,
            messages: fiveMessages,
        });
        const { report, texts } = await run();
        // 181 counted with `maxResponse` 10 and the empty card (48) is 229 > 220, so the full budget
        // (44) is held; the trim runs from 229 and drops the greeting (6) and m1 (23) to 200. Without
        // the response budget the ledger (219 with the card, before formatting) would fit whole.
        expect(texts).toEqual([
            `<Previous Conversation>${EMPTY_SUMMARY_CARD}</Previous Conversation>`,
            "b".repeat(20),
            "c".repeat(20),
            "d".repeat(20),
            "e".repeat(20),
        ]);
        expect(report.history).toEqual({ total: 6, kept: 4, totalUser: 3, keptUser: 2, droppedTokens: 29 });
        expect(report.memory).toEqual({
            kind: "hypaV3",
            tokens: 95,
            budget: 44,
            coverage: "gap",
            summarized: 0,
            reserved: 48,
            // The history trimmed without a summary still counts: the next send summarizes.
            summarizeIn: 0,
        });
        expect(report.input + report.maxResponse).toBeLessThanOrEqual(220);
    });

    /** A blocking step with half the context for memory and a stored summary of m1 and m2. */
    const halfBudgetBlocking = async (implementation: "standard" | "experimental", maxContext = 200) => {
        const blockingJob: AssemblyMemoryJob = {
            ...selectOnlyJob,
            preview: false,
            input: true,
            blockingReason: () => "requestTrigger",
            acquireWriter: async () => ({ release() {} }),
        };
        const preset = createHypaV3Preset(
            "Half",
            {
                memoryTokensRatio: 0.5,
                similarMemoryRatio: 0,
                useExperimentalImpl: implementation === "experimental",
            },
            "hypa-half",
        );
        const { run, chat } = contextAssembly({
            hypaV3: true,
            maxContext,
            memoryJob: blockingJob,
            template: [{ type: "memory" }, CHAT_CARD],
            db: { hypaV3Presets: [preset], hypaV3PresetId: preset.id },
            messages: fiveMessages,
        });
        chat.hypaV3Data = { summaries: [{ text: "S", chatMemos: ["m1", "m2"], isImportant: false }] };
        return run();
    };

    it("a blocking HypaV3 step (standard) whose plan reaches the protected tail over the context selects the real card instead of failing", async () => {
        const { report, texts } = await halfBudgetBlocking("standard");
        // 181 incoming (`maxResponse` 10 and 50 kept) with the empty card (48) is over 200, so the
        // stored summary comes in: less the summarized prefix (6 + 23 + 23) it is 129; with the full
        // budget 100 the plan holds 229 > 200 with only the tail (m3–m5) left. The real card
        // (`<Past Events Summary>\nS\n</Past Events Summary>`, 46 + 3) makes it 178, which fits.
        expect(texts).toEqual([
            "<Past Events Summary>\nS\n</Past Events Summary>",
            "c".repeat(20),
            "d".repeat(20),
            "e".repeat(20),
        ]);
        expect(report.input).toBe(49 + 3 * 23);
        // The stored summary covers m1 and m2, not the greeting; with a summary the next send
        // reserves the full budget, and its 229 is still over the context.
        expect(report.history.total - report.history.kept).toBe(3);
        expect(report.memory).toEqual({
            kind: "hypaV3",
            tokens: 49,
            budget: 100,
            coverage: "covered",
            summarized: 2,
            reserved: 100,
            summarizeIn: 0,
        });
    });

    it("a blocking HypaV3 step (experimental) whose plan reaches the protected tail over the context selects the real card instead of failing", async () => {
        const { report, texts } = await halfBudgetBlocking("experimental", 180);
        // 181 is over 180 without a card, so the stored summary comes in: less the summarized prefix
        // (6 + 23 + 23) it is 129; with the full budget 90 the plan holds 219 > 180 with only the tail
        // (m3–m5) left. The real card (46 + 3) makes it 178, which fits.
        expect(texts).toEqual([
            "<Past Events Summary>\nS\n</Past Events Summary>",
            "c".repeat(20),
            "d".repeat(20),
            "e".repeat(20),
        ]);
        expect(report.input).toBe(49 + 3 * 23);
        expect(report.history.total - report.history.kept).toBe(3);
        expect(report.memory).toEqual({
            kind: "hypaV3",
            tokens: 49,
            budget: 90,
            coverage: "covered",
            summarized: 2,
            reserved: 90,
            summarizeIn: 0,
        });
    });

    it("an experimental HypaV3 step holds no card while no summary is in: a stored summary waits while the raw history fits", async () => {
        const { report, texts } = await halfBudgetBlocking("experimental");
        // 181 fits in 200 without a card, so the summary of m1 and m2 is deferred and nothing is cut.
        expect(texts).toEqual(["Hi!", ...["a", "b", "c", "d", "e"].map((letter) => letter.repeat(20))]);
        expect(report.history.total - report.history.kept).toBe(0);
        expect(report.memory).toEqual({
            kind: "hypaV3",
            tokens: 0,
            budget: 100,
            coverage: "covered",
            summarized: 0,
            prepared: 2,
            reserved: 0,
            summarizeIn: 200 - 181 + 1,
        });
    });

    it("HypaV2 plans with its legacy count; the final recheck frees the response budget, dropping older history but never its last two chats", async () => {
        // `maxResponse` 300 of 1000 and an allocation of 10: HypaV2's own count (incoming less 300,
        // plus 10) fits, so it summarizes nothing; the formatted prompt is its card wrapped (137), the
        // greeting (6), m1–m3 (23 each), and m4.
        // HypaV2 always searches its chunks with the last chats: one local vector per text.
        const vectors = new Map<string, CachedVector>();
        const embeddings = createEmbeddings({
            cache: {
                get: (key) => vectors.get(key) ?? null,
                set: (key, vector) => vectors.set(key, vector),
                generation: () => 0,
                sync: () => {},
                clear: () => {},
                close: () => {},
                stats: () => ({ bytes: 0, rows: 0 }),
            },
            transformers: {
                runEmbedding: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
                runSummarizer: async () => "",
                runImageCaption: async () => "",
                runTextGeneration: async () => "",
                dispose: async () => {},
            },
            fetchImpl: (async () => {
                throw new Error("No embedding request leaves these tests");
            }) as typeof fetch,
        }).forJob({ db: { hypaModel: "MiniLM" } as never, supaMemoryKey: "", signal: new AbortController().signal });
        const v2 = (last: number) =>
            contextAssembly({
                embeddings,
                maxContext: 1000,
                character: { supaMemory: true },
                db: { maxResponse: 300, hypav2: true, hypaAllocatedTokens: 10, hypaChunkSize: 3000 },
                messages: [
                    ...fiveMessages.slice(0, 3),
                    { chatId: "m4", data: "z".repeat(last), role: "user" as Message["role"] },
                ],
            });
        // m4 500 (503): 715 is over the 700 budget; the greeting and m1 go (686).
        const fits = await v2(500).run();
        expect(fits.texts).toEqual([
            "<Previous Conversation><Past Events Summary></Past Events Summary>\n<Past Events Details></Past Events Details></Previous Conversation>",
            "b".repeat(20),
            "c".repeat(20),
            "z".repeat(500),
        ]);
        expect(fits.generationInfo.inputTokens).toBe(686);
        // m4 700 (703): after the greeting, m1, and m2 the prompt is still 863; m3 and m4 stay, so the
        // send ends with the too-many-tokens error instead of a prompt without the user's message.
        const over = v2(700);
        const result = await assemblePrompt(over.host, {
            chatAdditonalTokens: 3,
            continue: false,
            generationId: "counting",
            stageTimings: { stage1Duration: 0, stage2Duration: 0 },
        });
        expect(result).toMatchObject({ type: "error", error: expect.stringContaining("At token rechecking") });
        expect(result).toMatchObject({ error: expect.stringContaining("Required Tokens: 1163") });
    });

    it("the runner's token scope is the job scope's identity, which never uses a plugin tokenizer", () => {
        const db = {
            aiModel: "gpt4o",
            currentPluginProvider: "plug",
            customTokenizer: "",
            googleClaudeTokenizing: false,
            useTokenizerCaching: false,
        } as unknown as RequestDb;
        const key = tokenizerIdentityKey(tokenScopeFor(db));
        expect(JSON.parse(key)).toEqual([
            "gpt4o",
            "",
            "plug",
            false,
            resolveModelInfo("gpt4o").tokenizer,
            resolveModelInfo("gpt4o").internalID ?? null,
            "none",
        ]);
        // A tab scope with the plugin's declared tokenizer is a different identity.
        expect(tokenizerIdentityKey({ ...tokenScopeFor(db), pluginTokenizer: "plug-tokenizer" })).not.toBe(key);
        const runner = readFileSync(path.join(REPO_ROOT, "server/src/prompt/runner.ts"), "utf8");
        expect(runner).toContain("tokenScope: tokenizerIdentityKey(tokenScopeFor(requestDb)),");
    });
});
