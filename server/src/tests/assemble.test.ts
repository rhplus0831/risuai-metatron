// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ContextReport, historyDigest, parseContextReport } from "../../../shared/contextReport.ts";
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
                budget: { used: 0, limit: 0, rejectedCount: 0, rejectedTokens: 0 },
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
    };
    const CHAT_CARD: PromptItem = { type: "chat", rangeStart: 0, rangeEnd: "end" };
    const plain = (type2: "main" | "globalNote" | "normal", text: string): PromptItem => ({
        type: "plain",
        type2,
        text,
        role: "system",
    });
    const LORE_BUDGET = { used: 12, limit: 100, rejectedCount: 1, rejectedTokens: 40 };
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
            request: async () => {
                throw new Error("No summary request runs in these tests");
            },
            completions: async () => {
                throw new Error("No completion runs in these tests");
            },
            summarizer: async () => {
                throw new Error("No summarizer runs in these tests");
            },
            embeddings: { db: {} } as unknown as MemoryHost["embeddings"],
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
            readInlay: async () => null,
            readAsset: async () => null,
            moduleAssets: () => [],
            moduleToggles: () => "",
            runCurrentChatFunction() {},
            setLastMemory() {},
            memoryTrim: { enabled: () => false, confirm: async () => "trim" },
            memory,
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
            return { report, formated: result.formated, texts: result.formated.map((entry) => entry.content) };
        };
        return { run, chat, counts, host };
    }

    /** The report's fixed parts for this fixture. */
    const fixed = (chat: Chat, maxContext = 400) => ({
        v: 1 as const,
        maxContext,
        maxResponse: 10,
        lore: { budgetUsed: 12, budget: 100, rejectedCount: 1, rejectedTokens: 40, active: 0 },
        tokenScope: "counting",
        historyDigest: historyDigest(chat.message),
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
            lore: { budgetUsed: 12, budget: 100, rejectedCount: 1, rejectedTokens: 40, active: 1 },
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
        const memoryBlock = (tokens: number, coverage: "covered" | "unknown") => ({
            kind: "hypaV3" as const,
            tokens,
            budget: 80, // floor(400 × 0.2)
            coverage,
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

    it("HypaV3 reports a gap when a select-only step trims uncovered history", async () => {
        const previewJob: AssemblyMemoryJob = {
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
        const { run, chat } = contextAssembly({
            hypaV3: true,
            maxContext: 200,
            memoryJob: previewJob,
            messages: Array.from({ length: 5 }, (_, i) => ({
                chatId: `m${i + 1}`,
                data: String.fromCharCode(97 + i).repeat(20),
                role: i % 2 ? "char" : "user",
            })),
        });
        const { report, texts } = await run();
        // The ledger reaches the selection at 181 − 10 + 40 (the full memory budget, as the empty
        // card does not fit) = 211; the trim runs from 211 − 40 + 48 = 219 and drops the greeting
        // (6) and m1 (23) to 190, never the last three history entries.
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
            memory: { kind: "hypaV3", tokens: 95, budget: 40, coverage: "gap" },
        });
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
