// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeSecretPath, maskLlmSecrets, type FlatSecretField, type SecretPath } from "../../../shared/llmSecrets.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createResourceTestClient, parseArchive, sleep, type ResourceTestClient } from "./testSupport.ts";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`, write-only `llmSecrets`): the HTTP contract
// of the credential record. Every read route and the PUT response answer the masked projection
// (`shared/llmSecrets.ts`); a plain resource write may carry no credential path and keeps every
// stored credential; the credentials are written only through `/api/llm-secrets/*` (set, clear,
// delete, the preset copy) on the record's revision, with the same JWT, epoch, and maintenance rules
// as the resource writes; the path codec round-trips any id through a real URL; and a downloaded
// archive carries neither the record nor any byte of a current or replaced credential, while a
// server snapshot keeps the record.

const servers: ResourceTestClient[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server() {
    const s = await createResourceTestClient();
    servers.push(s);
    return s;
}

type Masked = { revision: string; data: Record<string, any> };

const flat = (field: FlatSecretField): SecretPath => ({ kind: "flat", field });
const preset = (id: string): SecretPath => ({ kind: "entry", field: "presets", id });
const model = (id: string): SecretPath => ({ kind: "entry", field: "customModels", id });
const oai = (id: string): SecretPath => ({ kind: "map", field: "OaiCompAPIKeys", id });

/** The masked record as a client reads it (`GET /api/resources/llmSecrets/main`). */
async function read(s: ResourceTestClient): Promise<Masked> {
    const res = await s.get("llmSecrets", "main");
    expect(res.status).toBe(200);
    return (await res.json()) as Masked;
}

/** `PUT /api/llm-secrets/<path>` on the current revision (or `baseRevision`), the raw response. */
async function putSecret(s: ResourceTestClient, target: SecretPath, value: string, baseRevision?: string) {
    const base = baseRevision ?? (await read(s)).revision;
    return s.json(`/api/llm-secrets/${encodeSecretPath(target)}`, { value, baseRevision: base }, { method: "PUT" });
}

async function setSecret(s: ResourceTestClient, target: SecretPath, value: string): Promise<Masked> {
    const res = await putSecret(s, target, value);
    expect(res.status, `${encodeSecretPath(target)}: ${await res.clone().text()}`).toBe(200);
    return (await res.json()) as Masked;
}

/** A plain resource write of the record on its current revision. */
async function putRecord(s: ResourceTestClient, data: unknown) {
    const { revision } = await read(s);
    return s.put("llmSecrets", "main", { baseRevision: revision, data });
}

/** The plaintext rows of a server snapshot (the server's own read path): the stored record. */
const reader = createResourceStore({ file: ":memory:", kinds: createKindRegistry(DEFAULT_RESOURCE_KINDS) });
afterAll(() => reader.close());
async function storedRecord(s: ResourceTestClient): Promise<Record<string, any> | undefined> {
    const snapshot = await s.context.snapshots.snapshotNow();
    const file = path.join(s.savePath, "backups", `${snapshot.id}.sqlite`);
    const row = reader.readSnapshot(file).rows.find((r) => r.kind === "llmSecrets");
    return row ? (JSON.parse(row.text) as Record<string, any>) : undefined;
}

const SENTINEL = {
    openai: "sk-openai-SENTINEL-AAAA",
    claude: "short",
    google: "AIza-google-SENTINEL-BBBB",
    horde: "horde-SENTINEL-CCCC",
    novelai: "pst-novel-SENTINEL-DDDD",
    compat: "compat-SENTINEL-EEEE",
    proxy: "pk-proxy-SENTINEL-FFFF",
    proto: "pk-proto-SENTINEL-GGGG",
    custom: "ck-custom-SENTINEL-HHHH",
};

/** A server holding one credential of every shape, and a readable sibling in every container. */
async function seeded() {
    const s = await server();
    await setSecret(s, flat("openAIKey"), SENTINEL.openai);
    await setSecret(s, flat("claudeAPIKey"), SENTINEL.claude);
    await setSecret(s, { kind: "nested", field: "google" }, SENTINEL.google);
    await setSecret(s, { kind: "nested", field: "hordeConfig" }, SENTINEL.horde);
    await setSecret(s, { kind: "nested", field: "novelai" }, SENTINEL.novelai);
    await setSecret(s, oai("https://compat.test/v1"), SENTINEL.compat);
    await setSecret(s, preset("p1"), SENTINEL.proxy);
    await setSecret(s, preset("__proto__"), SENTINEL.proto);
    await setSecret(s, model("xcustom:::m1"), SENTINEL.custom);
    const siblings = {
        google: { projectId: "proj-1" },
        hordeConfig: { model: "horde-model", softPrompt: "sp" },
        novelai: { model: "clio" },
        vertexClientEmail: "vertex@example.test",
        vertexAccessTokenExpires: 42,
    };
    const res = await putRecord(s, siblings);
    expect(res.status).toBe(200);
    return { s, siblings };
}

const everySentinel = Object.values(SENTINEL);
const carriesNoSentinel = (text: string) => {
    for (const value of everySentinel) {
        expect(text).not.toContain(value);
    }
};

describe("the masked projection", () => {
    it("answers every read route and the PUT response masked, keeps the siblings readable, and stores the record plaintext for the server", async () => {
        const { s, siblings } = await seeded();
        const expected = {
            ...maskLlmSecrets({}),
            ...siblings,
            openAIKey: { set: true, hint: "AAAA" },
            // A short value has no hint; an unset leaf is `{ set: false, hint: "" }`.
            claudeAPIKey: { set: true, hint: "" },
            google: { projectId: "proj-1", accessToken: { set: true, hint: "BBBB" } },
            hordeConfig: { model: "horde-model", softPrompt: "sp", apiKey: { set: true, hint: "CCCC" } },
            novelai: { model: "clio", token: { set: true, hint: "DDDD" } },
            OaiCompAPIKeys: { "https://compat.test/v1": { set: true, hint: "EEEE" } },
            presets: JSON.parse(
                '{"p1":{"proxyKey":{"set":true,"hint":"FFFF"}},"__proto__":{"proxyKey":{"set":true,"hint":"GGGG"}}}',
            ),
            customModels: { "xcustom:::m1": { key: { set: true, hint: "HHHH" } } },
        };
        const single = await s.get("llmSecrets", "main");
        const list = await s.list("llmSecrets");
        const kinds = await s.readKinds("llmSecrets,ui");
        const refs = await s.readRefs([{ kind: "llmSecrets", id: "main" }]);
        for (const res of [single, list, kinds, refs]) {
            expect(res.status).toBe(200);
            expect(res.headers.get("cache-control")).toBe("no-store");
        }
        const texts = await Promise.all([single, list, kinds, refs].map((res) => res.text()));
        for (const text of texts) {
            carriesNoSentinel(text);
        }
        const [singleBody, listBody, kindsBody, refsBody] = texts.map((text) => JSON.parse(text));
        expect(singleBody.data).toEqual(expected);
        expect(listBody.items).toHaveLength(1);
        expect(listBody.items[0].data).toEqual(expected);
        expect(kindsBody.kinds.llmSecrets[0].data).toEqual(expected);
        // Only the write-only kind is projected; the other kinds are answered as stored.
        expect(kindsBody.kinds.ui[0].data).toMatchObject({ zoomsize: expect.any(Number) });
        expect(refsBody.items[0]).toMatchObject({ kind: "llmSecrets", id: "main", data: expected });
        // An own `__proto__` id is an own key of the masked map too.
        expect(Object.hasOwn(singleBody.data.presets, "__proto__")).toBe(true);

        // The PUT response of a plain (sibling) write is masked as well.
        const put = await putRecord(s, { ...siblings, vertexClientEmail: "next@example.test" });
        expect(put.status).toBe(200);
        const putText = await put.text();
        carriesNoSentinel(putText);
        expect(JSON.parse(putText).data).toEqual({ ...expected, vertexClientEmail: "next@example.test" });

        // The server's own read keeps every credential.
        const stored = await storedRecord(s);
        expect(stored).toMatchObject({
            openAIKey: SENTINEL.openai,
            claudeAPIKey: SENTINEL.claude,
            google: { projectId: "proj-1", accessToken: SENTINEL.google },
            hordeConfig: { model: "horde-model", apiKey: SENTINEL.horde },
            novelai: { model: "clio", token: SENTINEL.novelai },
            OaiCompAPIKeys: { "https://compat.test/v1": SENTINEL.compat },
            customModels: { "xcustom:::m1": { key: SENTINEL.custom } },
            vertexClientEmail: "next@example.test",
        });
        expect(stored!.presets.p1).toEqual({ proxyKey: SENTINEL.proxy });
        expect(Object.hasOwn(stored!.presets, "__proto__")).toBe(true);
        expect(stored!.presets.__proto__).toEqual({ proxyKey: SENTINEL.proto });
    });
});

describe("the write rule of a plain resource write", () => {
    it("refuses a record that carries any credential path, in any shape, with 400 and no change, and never echoes the value", async () => {
        const { s, siblings } = await seeded();
        const before = await read(s);
        const carrying: [string, unknown][] = [
            ["the masked record read back", before.data],
            ["a flat string", { ...siblings, openAIKey: "VALUE-SENTINEL-1" }],
            ["an empty flat string", { ...siblings, openAIKey: "" }],
            ["a masked flat leaf", { ...siblings, openAIKey: { set: false, hint: "" } }],
            ["a nested leaf", { ...siblings, google: { projectId: "proj-1", accessToken: "VALUE-SENTINEL-2" } }],
            ["an empty nested leaf", { ...siblings, novelai: { model: "clio", token: "" } }],
            ["the OaiCompAPIKeys map, even empty", { ...siblings, OaiCompAPIKeys: {} }],
            ["the presets map", { ...siblings, presets: { p1: { proxyKey: "VALUE-SENTINEL-3" } } }],
            ["the customModels map, even empty", { ...siblings, customModels: {} }],
        ];
        for (const [what, data] of carrying) {
            const res = await putRecord(s, data);
            expect(res.status, what).toBe(400);
            const text = await res.text();
            expect(text, what).toContain("/api/llm-secrets");
            expect(text, what).not.toContain("VALUE-SENTINEL");
            carriesNoSentinel(text);
        }
        for (const data of [null, "text", [1]]) {
            expect((await putRecord(s, data)).status, String(data)).toBe(400);
        }
        expect((await read(s)).revision).toBe(before.revision);
        expect((await read(s)).data).toEqual(before.data);
    });

    it("keeps every stored credential on a write that omits them, also when a whole container or the record is empty", async () => {
        const { s } = await seeded();
        const before = await read(s);
        const stored = (await storedRecord(s))!;
        const res = await putRecord(s, { google: { projectId: "proj-2" }, vertexClientEmail: "two@example.test" });
        expect(res.status).toBe(200);
        const after = await read(s);
        expect(after.revision).not.toBe(before.revision);
        // The siblings are the write's (an omitted optional sibling stays absent, as the normalizer
        // leaves unset fields; an omitted container keeps only its credential)...
        expect(after.data).toMatchObject({
            google: { projectId: "proj-2", accessToken: { set: true, hint: "BBBB" } },
            hordeConfig: { apiKey: { set: true, hint: "CCCC" } },
            novelai: { token: { set: true, hint: "DDDD" } },
            vertexClientEmail: "two@example.test",
        });
        expect(after.data.hordeConfig).not.toHaveProperty("model");
        expect(after.data.novelai).not.toHaveProperty("model");
        // ...and every credential is as it was, the maps included.
        const next = (await storedRecord(s))!;
        for (const field of [
            "openAIKey",
            "claudeAPIKey",
            "OaiCompAPIKeys",
            "customModels",
            "mistralKey",
            "supaMemoryKey",
        ]) {
            expect(next[field], field).toEqual(stored[field]);
        }
        expect(next.google.accessToken).toBe(SENTINEL.google);
        expect(next.hordeConfig.apiKey).toBe(SENTINEL.horde);
        expect(next.novelai.token).toBe(SENTINEL.novelai);
        expect(JSON.stringify(next.presets)).toBe(JSON.stringify(stored.presets));
        // An empty record keeps them too.
        expect((await putRecord(s, {})).status).toBe(200);
        expect((await storedRecord(s))!.openAIKey).toBe(SENTINEL.openai);
        expect((await read(s)).data.presets.p1).toEqual({ proxyKey: { set: true, hint: "FFFF" } });
    });

    it("prepares every write-only op of a batch before anything is applied: a carrying op rolls the batch back, a sibling op merges", async () => {
        const { s, siblings } = await seeded();
        const secrets = await read(s);
        const ui = (await (await s.get("ui", "main")).json()) as { revision: string; data: Record<string, any> };
        const refused = await s.batch([
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, zoomsize: 77 } },
            {
                kind: "llmSecrets",
                id: "main",
                baseRevision: secrets.revision,
                data: { ...siblings, openAIKey: "VALUE-SENTINEL-4" },
            },
        ]);
        expect(refused.status).toBe(400);
        const text = await refused.text();
        expect(text).not.toContain("VALUE-SENTINEL");
        expect(((await (await s.get("ui", "main")).json()) as { data: { zoomsize: number } }).data.zoomsize).toBe(
            ui.data.zoomsize,
        );
        expect((await read(s)).revision).toBe(secrets.revision);

        const merged = await s.batch([
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, zoomsize: 77 } },
            {
                kind: "llmSecrets",
                id: "main",
                baseRevision: secrets.revision,
                data: { ...siblings, vertexClientEmail: "batch@example.test" },
            },
        ]);
        expect(merged.status).toBe(200);
        const body = (await merged.json()) as { results: { kind: string; revision: string | null }[] };
        // The batch answers revisions only, never a record body.
        expect(body.results.map((r) => r.kind)).toEqual(["ui", "llmSecrets"]);
        expect(JSON.stringify(body)).not.toContain("vertexClientEmail");
        expect(((await (await s.get("ui", "main")).json()) as { data: { zoomsize: number } }).data.zoomsize).toBe(77);
        expect((await read(s)).data).toMatchObject({
            vertexClientEmail: "batch@example.test",
            openAIKey: { set: true, hint: "AAAA" },
        });
        expect((await storedRecord(s))!.openAIKey).toBe(SENTINEL.openai);
    });

    it("refuses to delete the singleton, through the DELETE route and through a batch", async () => {
        const { s } = await seeded();
        const { revision } = await read(s);
        const single = await s.remove("llmSecrets", "main", `?baseRevision=${encodeURIComponent(revision)}`);
        expect(single.status).toBe(400);
        const batch = await s.batch([{ kind: "llmSecrets", id: "main", baseRevision: revision, delete: true }]);
        expect(batch.status).toBe(400);
        expect((await read(s)).revision).toBe(revision);
        expect((await storedRecord(s))!.openAIKey).toBe(SENTINEL.openai);
    });
});

describe("the secret routes", () => {
    it("sets, replaces, clears, and deletes a credential on the record's revision and answers the masked record", async () => {
        const s = await server();
        const first = await putSecret(s, flat("openAIKey"), "sk-first-SENTINEL-1111");
        expect(first.status).toBe(200);
        expect(first.headers.get("cache-control")).toBe("no-store");
        const firstBody = (await first.json()) as Masked & { epoch: string };
        expect(firstBody.epoch).toBe(s.epoch);
        expect(firstBody.data.openAIKey).toEqual({ set: true, hint: "1111" });
        expect(JSON.stringify(firstBody)).not.toContain("sk-first");
        expect((await read(s)).revision).toBe(firstBody.revision);

        const second = await setSecret(s, flat("openAIKey"), "sk-second-SENTINEL-2222");
        expect(second.revision).not.toBe(firstBody.revision);
        expect(second.data.openAIKey).toEqual({ set: true, hint: "2222" });
        expect((await storedRecord(s))!.openAIKey).toBe("sk-second-SENTINEL-2222");

        // An empty value clears a leaf.
        const cleared = await setSecret(s, flat("openAIKey"), "");
        expect(cleared.data.openAIKey).toEqual({ set: false, hint: "" });
        expect((await storedRecord(s))!.openAIKey).toBe("");

        // A map entry is created by a set and removed by an empty value or a DELETE.
        await setSecret(s, preset("p1"), "pk-1");
        await setSecret(s, oai("https://a.test"), "ok-1");
        await setSecret(s, model("m1"), "mk-1");
        expect((await read(s)).data).toMatchObject({
            presets: { p1: { proxyKey: { set: true, hint: "" } } },
            OaiCompAPIKeys: { "https://a.test": { set: true, hint: "" } },
            customModels: { m1: { key: { set: true, hint: "" } } },
        });
        await setSecret(s, preset("p1"), "");
        expect((await read(s)).data.presets).toEqual({});
        const { revision } = await read(s);
        const deleted = await s.request(
            `/api/llm-secrets/${encodeSecretPath(oai("https://a.test"))}?baseRevision=${encodeURIComponent(revision)}`,
            {
                method: "DELETE",
            },
        );
        expect(deleted.status).toBe(200);
        expect(((await deleted.json()) as Masked).data.OaiCompAPIKeys).toEqual({});
        const stored = (await storedRecord(s))!;
        expect(stored.OaiCompAPIKeys).toEqual({});
        expect(stored.presets).toEqual({});
        expect(stored.customModels).toEqual({ m1: { key: "mk-1" } });
        // The nested leaves and the vertex token are credentials too.
        await setSecret(s, { kind: "nested", field: "google" }, "g");
        await setSecret(s, flat("vertexAccessToken"), "vt");
        expect((await storedRecord(s))!).toMatchObject({ google: { accessToken: "g" }, vertexAccessToken: "vt" });
    });

    it("copies a preset's entry on the server, and removes the target's entry when the source has none", async () => {
        const s = await server();
        await setSecret(s, preset("a"), "pk-a-SENTINEL-ZZZZ");
        const copy = async (from: string, to: string) => {
            const { revision } = await read(s);
            return s.json("/api/llm-secrets/presets/copy", { from, to, baseRevision: revision });
        };
        const copied = await copy("a", "b");
        expect(copied.status).toBe(200);
        const body = (await copied.json()) as Masked;
        expect(body.data.presets).toEqual({
            a: { proxyKey: { set: true, hint: "ZZZZ" } },
            b: { proxyKey: { set: true, hint: "ZZZZ" } },
        });
        expect(JSON.stringify(body)).not.toContain("pk-a");
        expect((await storedRecord(s))!.presets).toEqual({
            a: { proxyKey: "pk-a-SENTINEL-ZZZZ" },
            b: { proxyKey: "pk-a-SENTINEL-ZZZZ" },
        });
        // A copy is a copy: replacing the source leaves the target.
        await setSecret(s, preset("a"), "pk-a2");
        expect((await storedRecord(s))!.presets.b).toEqual({ proxyKey: "pk-a-SENTINEL-ZZZZ" });
        // Copying from a preset without an entry removes the target's.
        expect((await copy("missing", "b")).status).toBe(200);
        expect((await storedRecord(s))!.presets).toEqual({ a: { proxyKey: "pk-a2" } });
        // Own `__proto__` ids on both sides.
        expect((await copy("a", "__proto__")).status).toBe(200);
        const stored = (await storedRecord(s))!;
        expect(Object.hasOwn(stored.presets, "__proto__")).toBe(true);
        expect(stored.presets.__proto__).toEqual({ proxyKey: "pk-a2" });
        for (const bad of [
            { from: "", to: "b" },
            { from: "a", to: "" },
            { from: "a" },
            { to: "b" },
            { from: 1, to: "b" },
            { from: "a", to: "b", baseRevision: 3 },
        ]) {
            const res = await s.json("/api/llm-secrets/presets/copy", bad);
            expect(res.status, JSON.stringify(bad)).toBe(400);
        }
    });

    it("refuses a stale revision with 409 and the current one, a missing or stale epoch with 412, writes during maintenance with 503, and requires the JWT", async () => {
        const s = await server();
        const current = await setSecret(s, flat("openAIKey"), "sk-1");
        const stale = await putSecret(s, flat("openAIKey"), "sk-stale", "stale-token");
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: "Revision conflict", revision: current.revision });
        const stored = (await storedRecord(s))!;
        expect(stored.openAIKey).toBe("sk-1");

        const { revision } = await read(s);
        const target = `/api/llm-secrets/${encodeSecretPath(flat("openAIKey"))}`;
        const body = { value: "sk-epoch", baseRevision: revision };
        const missing = await s.json(target, body, { method: "PUT" }, null);
        expect(missing.status).toBe(412);
        expect(await missing.json()).toEqual({ error: "EpochMismatch", epoch: s.epoch });
        const wrong = await s.json(target, body, { method: "PUT" }, "another-epoch");
        expect(wrong.status).toBe(412);
        const copyWrong = await s.json(
            "/api/llm-secrets/presets/copy",
            { from: "a", to: "b", baseRevision: revision },
            {},
            null,
        );
        expect(copyWrong.status).toBe(412);
        const deleteWrong = await s.request(
            `${target}?baseRevision=${encodeURIComponent(revision)}`,
            { method: "DELETE" },
            null,
        );
        expect(deleteWrong.status).toBe(412);
        expect((await read(s)).revision).toBe(revision);

        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            await held;
        });
        await sleep(20);
        const during = await s.json(target, body, { method: "PUT" });
        expect(during.status).toBe(503);
        expect(during.headers.get("retry-after")).toBe("5");
        // Reads stay open.
        expect((await s.get("llmSecrets", "main")).status).toBe(200);
        release();
        await maintenance;
        expect((await s.json(target, body, { method: "PUT" })).status).toBe(200);

        const anonymous = await s.app.request(target, {
            method: "PUT",
            headers: { "content-type": "application/json", "x-resource-epoch": s.epoch },
            body: JSON.stringify({ value: "sk-anon", baseRevision: revision }),
        });
        expect(anonymous.status).toBe(400);
        expect(await anonymous.json()).toEqual({ error: "No auth header" });
        expect((await storedRecord(s))!.openAIKey).toBe("sk-epoch");
    });

    it("refuses a bad path, body, or value with 400 without echoing the value", async () => {
        const s = await server();
        const { revision } = await read(s);
        const value = "VALUE-SENTINEL-9";
        const badPaths = [
            "",
            "nope",
            "google",
            "google/projectId",
            "google/accessToken/extra",
            "presets/~p1",
            "presets/p1/proxyKey",
            "presets/~/proxyKey",
            "presets/~p1/key",
            "customModels/~m1/proxyKey",
            "OaiCompAPIKeys/~a/extra",
            "OaiCompAPIKeys/a",
            "openAIKey/x",
            "%E0%A4%A",
            "presets/copy",
        ];
        for (const raw of badPaths) {
            const put = await s.json(`/api/llm-secrets/${raw}`, { value, baseRevision: revision }, { method: "PUT" });
            expect(put.status, `PUT ${raw}`).toBe(400);
            expect(await put.text(), `PUT ${raw}`).not.toContain(value);
            const del = await s.request(`/api/llm-secrets/${raw}?baseRevision=${encodeURIComponent(revision)}`, {
                method: "DELETE",
            });
            expect(del.status, `DELETE ${raw}`).toBe(400);
        }
        const target = `/api/llm-secrets/${encodeSecretPath(flat("openAIKey"))}`;
        for (const body of [
            { value: 1, baseRevision: revision },
            { value },
            { value, baseRevision: 1 },
            { baseRevision: revision },
            { value: "x".repeat(64 * 1024 + 1), baseRevision: revision },
            [value],
            "text",
            null,
        ]) {
            const res = await s.json(target, body, { method: "PUT" });
            expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
            expect(await res.text()).not.toContain(value);
        }
        const noBase = await s.request(target, { method: "DELETE" });
        expect(noBase.status).toBe(400);
        // The largest allowed value is accepted.
        expect((await putSecret(s, flat("openAIKey"), "y".repeat(64 * 1024))).status).toBe(200);
        expect((await read(s)).data.openAIKey).toEqual({ set: true, hint: "yyyy" });
    });

    it("the hint is the last four characters of a value of at least sixteen, and none for a shorter one", async () => {
        const s = await server();
        const fifteen = await setSecret(s, flat("mistralKey"), "123456789012345");
        expect(fifteen.data.mistralKey).toEqual({ set: true, hint: "" });
        const sixteen = await setSecret(s, flat("mistralKey"), "1234567890123456");
        expect(sixteen.data.mistralKey).toEqual({ set: true, hint: "3456" });
        // Whitespace is stored as pasted; the hint is of the stored value.
        const padded = await setSecret(s, flat("mistralKey"), "  1234567890123456  ");
        expect(padded.data.mistralKey).toEqual({ set: true, hint: "56  " });
        expect((await storedRecord(s))!.mistralKey).toBe("  1234567890123456  ");
    });

    it("round-trips any id through a real URL: dots, slashes, percent signs, Unicode, spaces, a tilde, and __proto__", async () => {
        const s = await server();
        const ids = [".", "..", "a/b", "a%2Fb", "a.b", "한글 id", "~x", "__proto__", "a?b#c", "a b", "%", "a\\b"];
        for (const id of ids) {
            const put = await putSecret(s, preset(id), `k-${id}`);
            expect(put.status, id).toBe(200);
            const masked = ((await put.json()) as Masked).data;
            expect(Object.hasOwn(masked.presets, id), id).toBe(true);
            expect(masked.presets[id], id).toEqual({ proxyKey: { set: true, hint: "" } });
        }
        const stored = (await storedRecord(s))!;
        expect(Object.keys(stored.presets).sort()).toEqual([...ids].sort());
        for (const id of ids) {
            expect(stored.presets[id], id).toEqual({ proxyKey: `k-${id}` });
        }
        expect(Object.getPrototypeOf(stored.presets)).toBe(Object.prototype);
        // A URL-like map id, and the same ids as custom-model ids.
        const url = "https://compat.test/v1/chat?x=1#y";
        await setSecret(s, oai(url), "ok");
        await setSecret(s, model("a/b.c"), "mk");
        expect((await storedRecord(s))!).toMatchObject({
            OaiCompAPIKeys: { [url]: "ok" },
            customModels: { "a/b.c": { key: "mk" } },
        });
        // Each id is removed by its own path, no other.
        for (const id of ids) {
            const { revision } = await read(s);
            const res = await s.request(
                `/api/llm-secrets/${encodeSecretPath(preset(id))}?baseRevision=${encodeURIComponent(revision)}`,
                { method: "DELETE" },
            );
            expect(res.status, id).toBe(200);
            const left = ((await res.json()) as Masked).data.presets;
            expect(Object.hasOwn(left, id), id).toBe(false);
        }
        expect((await storedRecord(s))!.presets).toEqual({});
    });
});

describe("the downloaded archive and the server snapshot", () => {
    const exportArchive = async (s: ResourceTestClient) => {
        const res = await s.json("/api/backups/export", {});
        expect(res.status).toBe(200);
        return parseArchive(new Uint8Array(await res.arrayBuffer()));
    };

    it("carries no llmSecrets row and no byte of a current or replaced credential, while a snapshot keeps the record", async () => {
        const s = await server();
        const replaced = "sk-replaced-SENTINEL-OLD1";
        const deleted = "pk-deleted-SENTINEL-OLD2";
        await setSecret(s, flat("openAIKey"), replaced);
        await setSecret(s, preset("gone"), deleted);
        await setSecret(s, preset("gone"), "");
        await setSecret(s, flat("openAIKey"), SENTINEL.openai);
        await setSecret(s, { kind: "nested", field: "google" }, SENTINEL.google);
        await setSecret(s, preset("p1"), SENTINEL.proxy);
        expect((await putRecord(s, { vertexClientEmail: "vertex@example.test" })).status).toBe(200);
        await s.create("characters", "a", { chaId: "a", name: "Alice" });

        const records = await exportArchive(s);
        expect(records.map((r) => r.name)).toEqual(["manifest.json", "resources.sqlite"]);
        const database = records[1].data;
        for (const value of [replaced, deleted, SENTINEL.openai, SENTINEL.google, SENTINEL.proxy]) {
            expect(database.indexOf(value), value).toBe(-1);
        }
        // The sibling went with the row: the archive has no `llmSecrets` row at all.
        expect(database.indexOf("vertex@example.test")).toBe(-1);
        const extracted = path.join(s.rootDir, "extracted.sqlite");
        writeFileSync(extracted, database);
        const rows = reader.readSnapshot(extracted).rows;
        expect(rows.some((r) => r.kind === "llmSecrets")).toBe(false);
        expect(rows.some((r) => r.kind === "characters" && r.id === "a")).toBe(true);
        expect(rows.some((r) => r.kind === "ui")).toBe(true);

        // The live record is untouched by the export, and a server snapshot keeps it.
        expect((await storedRecord(s))!).toMatchObject({
            openAIKey: SENTINEL.openai,
            google: { accessToken: SENTINEL.google },
            presets: { p1: { proxyKey: SENTINEL.proxy } },
            vertexClientEmail: "vertex@example.test",
        });
        const snapshot = await s.context.snapshots.snapshotNow();
        const bytes = readFileSync(path.join(s.savePath, "backups", `${snapshot.id}.sqlite`));
        expect(bytes.indexOf(SENTINEL.openai)).not.toBe(-1);
    });

    it("imports an archive without the row as a fresh record: every key empty under the new epoch, the old epoch's writes refused", async () => {
        const source = await server();
        await setSecret(source, flat("openAIKey"), SENTINEL.openai);
        await source.create("characters", "a", { chaId: "a", name: "Alice" });
        const archive = await source.json("/api/backups/export", {});
        const bytes = new Uint8Array(await archive.arrayBuffer());

        const target = await server();
        await setSecret(target, flat("claudeAPIKey"), SENTINEL.claude);
        await setSecret(target, preset("t1"), SENTINEL.proxy);
        const oldEpoch = target.epoch;
        const res = await target.request("/api/backups/import", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
            duplex: "half",
        } as RequestInit);
        expect(res.status).toBe(200);
        const { epoch } = (await res.json()) as { epoch: string };
        expect(epoch).not.toBe(oldEpoch);
        expect(await target.readEpoch()).toBe(epoch);
        const after = await read(target);
        // The normalizer's fresh record: every key unset, the siblings at their defaults.
        expect(after.data).toEqual(maskLlmSecrets(normalizeLlmSecrets(undefined) as Record<string, unknown>));
        expect(after.revision.startsWith(`${epoch}:`)).toBe(true);
        const stored = (await storedRecord(target))!;
        expect(stored.openAIKey).toBe("");
        // An optional credential field has no default: absent in a fresh record, never the target's.
        expect(stored.claudeAPIKey ?? "").toBe("");
        expect(stored.presets).toEqual({});
        const characters = (await (await target.list("characters")).json()) as { items: { id: string }[] };
        expect(characters.items.map((c) => c.id)).toEqual(["a"]);
        // A credential write based on the old epoch is refused; one on the new epoch lands.
        const old = await target.json(
            `/api/llm-secrets/${encodeSecretPath(flat("openAIKey"))}`,
            { value: "sk-old", baseRevision: after.revision },
            { method: "PUT" },
            oldEpoch,
        );
        expect(old.status).toBe(412);
        expect((await putSecret(target, flat("openAIKey"), "sk-new")).status).toBe(200);
        expect((await storedRecord(target))!.openAIKey).toBe("sk-new");
    });
});
