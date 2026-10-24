// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPSTREAM_IMPORT_PREPARE_PATH, type UpstreamImportPrepared } from "../../../shared/upstreamBackup.ts";
import { stageUpstreamImport } from "../data/upstream/importStage.ts";
import { encodeBlockSave } from "./fixtures/upstream/blockSave.ts";
import { UPSTREAM_FIXTURE_DATABASE } from "./fixtures/upstream/database.ts";
import { buildArchive, createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

let server: ResourceTestClient | undefined;

afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.useRealTimers();
});

describe("upstream import report", () => {
    it("reports every raw SaveKV namespace under its own excluded code", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        server = await createResourceTestClient({
            upstreamImport: { runner: (input, { onProgress }) => stageUpstreamImport(input, onProgress) },
        });
        // More than five names, including a literal kv: prefix that belongs to the namespace.
        const namespaces = ["plugin:notes", "preferences", "kv:literal", "한글", "alpha", "beta", "seventh"];
        const kv = Object.fromEntries(namespaces.map((name) => [name, { value: "left out" }]));
        const archive = buildArchive([["database.risudat", encodeBlockSave(UPSTREAM_FIXTURE_DATABASE, { kv })]]);
        const response = await server.request(UPSTREAM_IMPORT_PREPARE_PATH, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: archive,
        });
        expect(response.status).toBe(200);
        const result = JSON.parse((await response.text()).trim().split("\n").at(-1)!) as UpstreamImportPrepared;
        expect(result.report.excluded.filter(({ code }) => code === "savekv-namespace")).toEqual([
            { code: "savekv-namespace", count: 7, examples: expect.arrayContaining(namespaces) },
        ]);
        expect(result.report.excluded.find(({ code }) => code === "unknown-setting")?.examples ?? []).not.toEqual(
            expect.arrayContaining([expect.stringMatching(/^kv:/)]),
        );
    });
});
