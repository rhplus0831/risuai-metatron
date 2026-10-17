// @vitest-environment node
import http from "node:http";
import path from "node:path";
import { symlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createScriptCache, type RegexScriptMode } from "../../../shared/scripts/regex.ts";
import type { character, customscript } from "../../../shared/database.ts";
import { createScriptWorkerPool } from "../scripts/workerPool.ts";
import { createScriptProcessor, runScriptTail } from "../prompt/scripts.ts";
import type { RunSetup } from "../jobs/runSetup.ts";
import { createResourceTestClient } from "./testSupport.ts";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const workers = createScriptWorkerPool({ rootDir, size: 1, maxSize: 1 });
afterAll(() => workers.dispose());

// Real regex workers and nearest-vector ranking, with deterministic vectors and identity CBS.
function fixture(scripts: customscript[] = [], flags: Record<string, boolean> = {}) {
    const char = {
        type: "character",
        chaId: "c",
        additionalAssets: [
            ["sad", "sad.png"],
            ["happy", "happy.png"],
        ],
        customscript: scripts,
        triggerscript: [],
        chats: [{ id: "k", message: [] }],
    } as unknown as character;
    const signal = new AbortController().signal;
    const embed = vi.fn(async (inputs: string[]) => inputs.map((s) => new Float32Array(s === "sad" ? [0, 1] : [1, 0])));
    const embeddings = vi.fn(() => ({
        db: { hypaModel: "MiniLM" },
        supaMemoryKey: "",
        generation: 0,
        signal,
        cache: new Map(),
        redact: (s: string) => s,
        carries: () => false,
        transformers: { runEmbedding: embed },
        fetchImpl: () => {
            throw new Error("Unexpected network");
        },
    }));
    const setup = {
        scope: {
            characterId: "c",
            chatId: "k",
            db: {
                dynamicAssets: true,
                dynamicAssetsEditDisplay: true,
                ...flags,
                presetRegex: [],
                characters: [char],
                personas: [],
                modules: [],
                enabledModules: [],
            },
        },
        nativeCtx: { signal, identity: { characterId: "c", chatId: "k", presetId: null, personaId: null } },
        check() {},
        bindings: { evaluator: { risuChatParser: (s: string) => s }, services: { embeddings, fence() {} } },
    } as unknown as RunSetup;
    const deps = { setup, scriptWorkers: workers, cache: createScriptCache(), assetMatches: new Map<string, string>() };
    return {
        char,
        deps,
        embed,
        embeddings,
        run: (text: string, mode: RegexScriptMode) => runScriptTail(deps, char, text, mode, -1, {}, () => {}),
    };
}
const regex = (mode: RegexScriptMode): customscript => ({
    comment: "produce a marker",
    in: "MARKER",
    out: "{{img::hapy}}",
    type: mode,
    flag: "g",
});

describe("dynamic assets in the server script tail", () => {
    it.each(["editoutput", "editdisplay"] as const)(
        "ranks unknown markers in %s with zero regex scripts or after a regex",
        async (mode) => {
            for (const withRegex of [false, true]) {
                const f = fixture(withRegex ? [regex(mode)] : []);
                expect(await f.run(withRegex ? "MARKER" : "{{img::hapy}}", mode)).toBe("{{img::happy}}");
                expect(f.embed.mock.calls.flatMap(([inputs]) => inputs)).toEqual(
                    expect.arrayContaining(["sad", "happy", "hapy"]),
                );
            }
        },
    );
    it.each([
        ["editinput", {}],
        ["editprocess", {}],
        ["editoutput", { dynamicAssets: false }],
        ["editdisplay", { dynamicAssetsEditDisplay: false }],
    ] as [RegexScriptMode, Record<string, boolean>][])(
        "leaves markers alone in %s with flags %j",
        async (mode, flags) => {
            for (const withRegex of [false, true]) {
                const f = fixture(withRegex ? [regex(mode)] : [], flags);
                expect(await f.run("{{img::hapy}}", mode)).toBe("{{img::hapy}}");
                expect(f.embeddings).not.toHaveBeenCalled();
                expect(f.embed).not.toHaveBeenCalled();
            }
        },
    );
    it("does not build an embedding processor or embed assets when no marker needs ranking", async () => {
        for (const scripts of [[], [regex("editoutput")]]) {
            for (const source of [
                "Plain text",
                "{{img::happy}}",
                "{{emotion::hapy}} {{source::hapy}}",
                "{{img::cached}}",
            ]) {
                const f = fixture(scripts);
                f.deps.assetMatches.set("c::cached", "happy");
                expect(await f.run(source, "editoutput")).toBe(source.replace("{{img::cached}}", "{{img::happy}}"));
                expect(f.embeddings).not.toHaveBeenCalled();
                expect(f.embed).not.toHaveBeenCalled();
            }
        }
    });
    it("applies dynamic assets to the send processor's output with no regex scripts", async () => {
        const f = fixture();
        const processor = createScriptProcessor({
            ...f.deps,
            job: { hooks: { scripts: [] } },
            lock: {},
            showEmotion: vi.fn(),
        } as unknown as Parameters<typeof createScriptProcessor>[0]);
        expect(await processor.process(f.char, "{{img::hapy}}", "editoutput")).toEqual({
            data: "{{img::happy}}",
            emoChanged: false,
        });
    });
});

describe("dynamic assets through /api/transform", () => {
    let client: Awaited<ReturnType<typeof createResourceTestClient>>;
    const requests: string[][] = [];
    const embedder = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        const { input } = JSON.parse(Buffer.concat(parts).toString());
        const inputs: string[] = Array.isArray(input) ? input : [input];
        requests.push(inputs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: inputs.map((s) => ({ embedding: s === "sad" ? [0, 1] : [1, 0] })) }));
    });
    let ids: { presetId: string; modelPresetId: string; personaId: string };
    const record = async <T = Record<string, unknown>>(kind: string) =>
        (await (await client.request(`/api/resources/${kind}/main`)).json()) as { revision: string; data: T };
    async function patch(kind: string, fields: Record<string, unknown>) {
        const current = await record(kind);
        const response = await client.json("/api/resources/batch", {
            ops: [{ kind, id: "main", baseRevision: current.revision, data: { ...current.data, ...fields } }],
        });
        expect(response.status, JSON.stringify(await response.json())).toBe(200);
    }
    beforeAll(async () => {
        await new Promise<void>((resolve) => embedder.listen(0, "127.0.0.1", resolve));
        client = await createResourceTestClient();
        symlinkSync(path.join(rootDir, "public"), path.join(client.rootDir, "public"), "dir");
        ids = {
            presetId: (await record<{ id: string }[]>("presets")).data[0].id,
            modelPresetId: (await record<{ id: string }[]>("modelPresets")).data[0].id,
            personaId: (await record<{ id: string }[]>("personas")).data[0].id,
        };
        await patch("memoryTranslateMedia", { hypaModel: "custom", dynamicAssets: true });
        await patch("ui", { dynamicAssetsEditDisplay: true });
        await patch("secrets", {
            hypaCustomSettings: {
                url: `http://127.0.0.1:${(embedder.address() as { port: number }).port}/v1/embeddings`,
                key: "test",
                model: "test",
            },
        });
        const created = await client.json("/api/resources/batch", {
            ops: [
                {
                    kind: "characters",
                    id: "dyn",
                    baseRevision: null,
                    data: {
                        chaId: "dyn",
                        name: "Dynamic",
                        type: "character",
                        firstMessage: "hi",
                        desc: "",
                        globalLore: [],
                        customscript: [],
                        triggerscript: [],
                        additionalAssets: [
                            ["sad", "sad.png", "png"],
                            ["happy", "happy.png", "png"],
                        ],
                    },
                },
            ],
            chats: [
                {
                    characterId: "dyn",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: { id: "k", name: "K", message: [{ role: "char", data: "hi", chatId: "m1" }] },
                        },
                    ],
                },
            ],
        });
        expect(created.status, JSON.stringify(await created.json())).toBe(200);
    });
    afterAll(async () => {
        await client?.close();
        embedder.closeAllConnections();
        await new Promise<void>((resolve) => embedder.close(() => resolve()));
    });
    it("replaces an unknown display asset with no regex scripts, without embedding plain text", async () => {
        const render = (source: string) =>
            client.json("/api/transform", {
                clientId: "dynamic-assets-test",
                mode: "editdisplay",
                context: { characterId: "dyn", chatId: "k", ...ids, selectedPersonaId: ids.personaId },
                client: { viewport: { width: 800, height: 600 }, browserLanguage: "en" },
                targets: [{ id: "t", kind: "message", sourceId: "dyn", chatIndex: 0, messageId: "m1", source }],
            });
        requests.length = 0;
        const plain = await render("No image marker");
        expect(plain.status).toBe(200);
        expect(((await plain.json()) as { results: unknown[] }).results[0]).toMatchObject({
            ok: true,
            text: "No image marker",
        });
        expect(requests).toEqual([]);
        const marked = await render("{{img::hapy}}");
        expect(marked.status).toBe(200);
        expect(((await marked.json()) as { results: unknown[] }).results[0]).toMatchObject({
            ok: true,
            text: "{{img::happy}}",
        });
        expect(requests.flat()).toEqual(expect.arrayContaining(["sad", "happy", "hapy"]));
    });
});
