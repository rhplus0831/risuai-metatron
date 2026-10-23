// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveRejectedError } from "../data/archive.ts";
import {
    planUpstreamArchive,
    readColdEntry,
    readColdRecord,
    UPSTREAM_ENCRYPTED_MESSAGE,
    type UpstreamArchivePlan,
} from "../data/upstream/archive.ts";
import { buildArchive } from "./testSupport.ts";

const COLD_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const COLD_B = "ABCDEF01-2345-4678-9ABC-DEF012345678";

let root: string;
let savePath: string;
let fileCount = 0;

beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "risu-upstream-archive-"));
    savePath = path.join(root, "save");
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

async function withArchive<T>(
    records: [string, Uint8Array | string][],
    run: (handle: fs.FileHandle) => Promise<T>,
): Promise<T> {
    const file = path.join(root, `archive-${fileCount++}.bin`);
    writeFileSync(file, buildArchive(records));
    const handle = await fs.open(file, "r");
    try {
        return await run(handle);
    } finally {
        await handle.close();
    }
}

function plan(records: [string, Uint8Array | string][]): Promise<UpstreamArchivePlan> {
    return withArchive(records, (handle) => planUpstreamArchive(handle, savePath));
}

async function refusal(records: [string, Uint8Array | string][]): Promise<string> {
    const error: unknown = await plan(records).then(
        () => null,
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ArchiveRejectedError);
    return (error as Error).message;
}

describe("planUpstreamArchive", () => {
    it("sorts the database, both cold-storage name forms and the assets, in any order", async () => {
        const result = await plan([
            ["a.png", "A"],
            [`coldstorage_${COLD_A}.json`, "{}"],
            ["database.risudat", "DB"],
            [`${COLD_B}.json`, "[]"],
            ["b.png", "B"],
            // Not UUID-shaped: an ordinary asset, as upstream's restore treats it.
            ["coldstorage_notauuid.json", "{}"],
        ]);
        expect(result.database.name).toBe("database.risudat");
        expect(result.database.length).toBe(2);
        expect(result.cold.map((entry) => [entry.key, entry.records.map((record) => record.name)])).toEqual([
            [COLD_A, [`coldstorage_${COLD_A}.json`]],
            [COLD_B, [`${COLD_B}.json`]],
        ]);
        expect(result.assets.map((asset) => [asset.key, asset.target])).toEqual([
            ["assets/a.png", path.join(savePath, "assets", "a.png")],
            ["assets/b.png", path.join(savePath, "assets", "b.png")],
            ["assets/coldstorage_notauuid.json", path.join(savePath, "assets", "coldstorage_notauuid.json")],
        ]);
        expect(result.ignored).toEqual([]);
    });

    it("keeps every record of a cold-storage key written under both names, in archive order", async () => {
        const result = await plan([
            [`coldstorage_${COLD_A}.json`, "[1]"],
            ["database.risudat", "DB"],
            [`${COLD_A}.json`, "[2]"],
        ]);
        expect(result.cold).toHaveLength(1);
        expect(result.cold[0].records.map((record) => record.name)).toEqual([
            `coldstorage_${COLD_A}.json`,
            `${COLD_A}.json`,
        ]);
        expect(result.ignored).toEqual([]);
    });

    it("ignores and lists an asset name that has no storage location", async () => {
        const long = "n".repeat(300) + ".png";
        const result = await plan([
            [long, "x"],
            ["ok.png", "x"],
            ["database.risudat", "DB"],
        ]);
        expect(result.assets.map((asset) => asset.key)).toEqual(["assets/ok.png"]);
        expect(result.ignored).toEqual([{ name: long, reason: "invalidAssetKey" }]);
    });

    it("refuses a Risu Account backup before any other problem", async () => {
        expect(
            await refusal([
                ["a.png", "x"],
                ["encryption.risudat", '{"type":"account"}'],
                ["database.risudat", "DB"],
            ]),
        ).toBe(UPSTREAM_ENCRYPTED_MESSAGE);
        expect(
            await refusal([
                ["sub/a.png", "x"],
                ["encryption.risudat", "x"],
            ]),
        ).toBe(UPSTREAM_ENCRYPTED_MESSAGE);
    });

    it("refuses a missing or doubled database, a duplicate name, and a slashed name", async () => {
        expect(await refusal([["a.png", "x"]])).toBe("The backup holds no database (database.risudat)");
        expect(await refusal([])).toBe("The backup holds no database (database.risudat)");
        expect(
            await refusal([
                ["database.risudat", "DB"],
                ["database.risudat", "DB"],
            ]),
        ).toBe("The archive holds database.risudat twice");
        expect(
            await refusal([
                ["a.png", "x"],
                ["a.png", "y"],
                ["database.risudat", "DB"],
            ]),
        ).toBe("The archive holds a.png twice");
        for (const name of ["assets/a.png", "..\\a.png", `coldstorage/${COLD_A}.json`]) {
            expect(
                await refusal([
                    [name, "x"],
                    ["database.risudat", "DB"],
                ]),
            ).toBe(`The archive holds an unexpected record: ${name}`);
        }
    });

    it("refuses a version-2 archive of this server", async () => {
        const message = "This is a backup archive of this server, not a RisuAI backup; use the regular import";
        expect(
            await refusal([
                ["manifest.json", '{"version":2}'],
                ["resources.sqlite", "x"],
                ["assets/a.png", "x"],
            ]),
        ).toBe(message);
        expect(
            await refusal([
                ["resources.sqlite", "x"],
                ["database.risudat", "DB"],
            ]),
        ).toBe(message);
    });

    it("refuses a malformed container", async () => {
        const file = path.join(root, "truncated.bin");
        const bytes = buildArchive([["database.risudat", "DB"]]);
        writeFileSync(file, bytes.subarray(0, bytes.length - 1));
        const handle = await fs.open(file, "r");
        try {
            await expect(planUpstreamArchive(handle, savePath)).rejects.toThrow(
                new ArchiveRejectedError("The archive is truncated"),
            );
        } finally {
            await handle.close();
        }
    });

    it("stops the index at the next window read once its signal aborts, and never starts on an aborted one", async () => {
        // Records over the index window, so every header costs a read of its own.
        const big = new Uint8Array(70 * 1024);
        const records: [string, Uint8Array | string][] = [
            ["a.png", big],
            ["b.png", big],
            ["c.png", big],
            ["database.risudat", "DB"],
        ];
        await withArchive(records, async (handle) => {
            const controller = new AbortController();
            let reads = 0;
            const counting = {
                stat: () => handle.stat(),
                read: (...args: Parameters<fs.FileHandle["read"]>) => {
                    reads++;
                    if (reads === 2) {
                        controller.abort(new Error("the import stopped"));
                    }
                    return handle.read(...args);
                },
            } as unknown as fs.FileHandle;
            await expect(planUpstreamArchive(counting, savePath, controller.signal)).rejects.toThrow(
                "the import stopped",
            );
            expect(reads).toBe(2);
            // Without a signal the same archive is planned in full.
            expect((await planUpstreamArchive(handle, savePath)).assets).toHaveLength(3);
        });
        await withArchive(records, async (handle) => {
            let reads = 0;
            const counting = {
                stat: () => handle.stat(),
                read: (...args: Parameters<fs.FileHandle["read"]>) => {
                    reads++;
                    return handle.read(...args);
                },
            } as unknown as fs.FileHandle;
            const aborted = AbortSignal.abort(new Error("already gone"));
            await expect(planUpstreamArchive(counting, savePath, aborted)).rejects.toThrow("already gone");
            expect(reads).toBe(0);
        });
    });
});

const data = (value: unknown) => ({ ok: true, kind: "data", value, pluginValue: value });
const plugin = (value: unknown) => ({ ok: true, kind: "plugin", value, pluginValue: value });

describe("readColdRecord", () => {
    async function readCold(data: Uint8Array | string, cap?: number) {
        const name = `coldstorage_${COLD_A}.json`;
        return withArchive(
            [
                [name, data],
                ["database.risudat", "DB"],
            ],
            async (handle) => {
                const { cold } = await planUpstreamArchive(handle, savePath);
                return readColdRecord(handle, cold[0].records[0], cap);
            },
        );
    }

    it("parses a character payload, a chat payload and an older bare message array", async () => {
        const character = { character: { name: "A", chaId: "c" } };
        const chat = { message: [{ role: "user", data: "안녕" }], localLore: [] };
        expect(await readCold(JSON.stringify(character))).toEqual(data(character));
        expect(await readCold(JSON.stringify(chat))).toEqual(data(chat));
        expect(await readCold('[{"role":"char","data":"x"}]')).toEqual(data([{ role: "char", data: "x" }]));
        // TextDecoder drops a byte-order mark, as upstream's restore does.
        expect(await readCold("﻿[]")).toEqual(data([]));
    });

    it("reports an oversized or unparsable payload instead of throwing and reads any other JSON as plugin storage", async () => {
        const payload = JSON.stringify({ message: [] });
        expect(await readCold(payload, payload.length - 1)).toEqual({ ok: false, reason: "tooLarge" });
        expect(await readCold(payload, payload.length)).toEqual(data({ message: [] }));
        expect(await readCold("{not json")).toEqual({ ok: false, reason: "invalidJson" });
        expect(await readCold("")).toEqual({ ok: false, reason: "invalidJson" });
        expect(await readCold('{"other":1}')).toEqual(plugin({ other: 1 }));
        expect(await readCold("null")).toEqual(plugin(null));
    });
});

describe("readColdEntry", () => {
    async function readEntry(payloads: string[], cap?: number) {
        const names = [`${COLD_A}.json`, `coldstorage_${COLD_A}.json`];
        const records: [string, string][] = payloads.map((payload, i) => [names[i], payload]);
        return withArchive([...records, ["database.risudat", "DB"]], async (handle) => {
            const { cold } = await planUpstreamArchive(handle, savePath);
            return readColdEntry(handle, cold[0], cap);
        });
    }

    it("takes the last valid payload, as upstream's restore keeps the last one it accepted", async () => {
        expect(await readEntry(["[1]", "[2]"])).toEqual(data([2]));
        expect(await readEntry(['{"message":[]}', "{"])).toEqual(data({ message: [] }));
        // A data record stays the character/chat payload; plugin storage reads the later plugin record.
        expect(await readEntry(['{"message":[]}', '{"other":1}'])).toEqual({
            ok: true,
            kind: "data",
            value: { message: [] },
            pluginValue: { other: 1 },
        });
        expect(await readEntry(['{"message":[]}', JSON.stringify({ message: ["x".repeat(40)] })], 20)).toEqual(
            data({ message: [] }),
        );
    });

    it("reports the last record's failure when none is valid", async () => {
        expect(await readEntry(["{", "[1,2,3]"], 3)).toEqual({ ok: false, reason: "tooLarge" });
        expect(await readEntry(["[1,2,3]", "{"], 3)).toEqual({ ok: false, reason: "invalidJson" });
    });

    it("keeps an earlier plugin value beside later data and uses the last plugin value when there is no data", async () => {
        expect(await readEntry(['"plugin text"', '{"message":[]}'])).toEqual({
            ok: true,
            kind: "data",
            value: { message: [] },
            pluginValue: "plugin text",
        });
        expect(await readEntry(['"older plugin text"', "null"])).toEqual(plugin(null));
    });
});
