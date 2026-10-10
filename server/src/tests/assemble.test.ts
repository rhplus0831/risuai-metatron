// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenAIChat } from "../../../shared/openai.ts";
import {
    normalizePreset,
    PERSONA_ROOT_ALIASES,
    PRESET_DEFAULTS,
    PRESET_ROOT_ALIASES,
} from "../../../shared/presets.ts";
import { FORWARDED_MODEL_PRESET_KEYS, FORWARDED_PRESET_KEYS, SECTION_FIELDS } from "../../../shared/sections.ts";
import { createSigner, createTestServer, json } from "./testSupport.ts";

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
