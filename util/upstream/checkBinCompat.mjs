// Checks metatron's upstream RisuAI `.bin` output against upstream's own code at a pinned commit
// (`docs/structure/backup-sync-hub.md` Tests). Not part of `pnpm test`: it needs an upstream checkout
// and upstream's library versions, and it never installs or starts the upstream app.
//
//   RISU_UPSTREAM_DIR=<upstream RisuAI checkout holding the pinned commit> \
//   RISU_UPSTREAM_MSGPACKR=<msgpackr 1.10.1 package dir> RISU_UPSTREAM_FFLATE=<fflate 0.8.2 package dir> \
//   node util/upstream/checkBinCompat.mjs [--bin <file.bin>]...
//
// Without `--bin` it runs three checks on synthetic data:
// 1. encoder: `encodeUpstreamDatabase` (S1) output decoded by upstream's `decodeRisuSave` equals the input
//    (the frozen codec fixture and an edge-case object).
// 2. export: a synthetic upstream library imported through this server's upstream import routes, then
//    exported through the RisuAI-compatible export routes (without and with API keys); upstream's
//    decoder and this server's must read the same `database.risudat`, and the result is compared with
//    the input library under the export's documented conversions.
// 3. boot: upstream's `setDatabase`, `checkNewFormat` (with `checkCharOrder`) and `assignIds` run on each
//    decoded export without a throw, a console warning or error, or an unapproved stub use, and keep
//    every character, chat, and message.
// `--bin <file>` runs the decoder comparison and the boot pass on an existing `.bin` (meant for this
// server's exports; for an upstream backup the counts include cold-storage stubs). It prints counts and
// fixed failure categories only, never a name, text, or a caught error, so it is safe on private files.
// Use trusted local files only: this manual check runs upstream's decoder in this process.
// The synthetic scenario uses one flat openAIKey; named-key placement, auxiliary-secret clearing and
// native-field stripping are covered by upstreamExport.test.ts / upstreamExportRoute.test.ts instead.
// The exporter branch for a character with no stored chats is covered by upstreamExport.test.ts;
// the boot rule here allows its id-less empty chat to receive an id and checks all resulting ids.
// Not covered (upstream code not run): `LoadLocalBackup`'s record reader and asset writes,
// `makeColdData`, `cleanChunks`, plugin loading, and the upstream UI.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { indexArchive, readRecord } from "../../server/src/data/archive.ts";
import { stageUpstreamImport } from "../../server/src/data/upstream/importStage.ts";
import { decodeUpstreamDatabase, encodeUpstreamDatabase } from "../../server/src/data/upstream/risuSave.ts";
import { UPSTREAM_FIXTURE_DATABASE } from "../../server/src/tests/fixtures/upstream/database.ts";
import { buildArchive, createResourceTestClient } from "../../server/src/tests/testSupport.ts";
import { PROMPT_PRESET_FIELDS } from "../../shared/presets.ts";
import { UPSTREAM_IMPORT_COMMIT_PATH, UPSTREAM_IMPORT_PREPARE_PATH } from "../../shared/upstreamBackup.ts";
import { UPSTREAM_EXPORT_DOWNLOAD_PATH, UPSTREAM_EXPORT_PREPARE_PATH } from "../../shared/upstreamExportReport.ts";
import { loadUpstream, runPhase, UPSTREAM_COMMIT } from "./upstreamHarness.mjs";

const MAX_DECODED_BYTES = 1024 * 1024 * 1024;

/** Stub uses upstream's modules make while loading: store and storage-instance construction. */
const LOAD_APPROVED = new Set([
    "pkg:svelte/store#writable()",
    "src/ts/process/memory/hypamemory.ts#HypaProcesser.prototype",
    "pkg:localforage#default.createInstance",
    "pkg:localforage#default.createInstance()",
]);
/** The boot pass's only stub use: `setDatabase` applying the UI language. */
const BOOT_APPROVED = new Set(["src/lang/index.ts#changeLanguage()"]);

let failures = 0;
const pass = (name, detail = "") => console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
const fail = (name, problems) => {
    failures++;
    console.log(`FAIL ${name}`);
    for (const problem of problems.slice(0, 20)) console.log(`  - ${problem}`);
    if (problems.length > 20) console.log(`  - ... ${problems.length - 20} more`);
};
const report = (name, problems, detail) => (problems.length === 0 ? pass(name, detail) : fail(name, problems));

// ---------------------------------------------------------------------------------------------------
// Comparison

const isBinary = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);
const isPlain = (v) =>
    v !== null &&
    typeof v === "object" &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Structural differences with fixed kinds and optional diagnostic paths, never compared values.
 * Paths can contain user keys: only synthetic checks may print them. Binary values compare by bytes;
 * an own `undefined` differs from a missing key or array hole; BigInt vs number is `int64`.
 */
function differences(a, b, at = "$", out = []) {
    if (out.length >= 50) return out;
    const add = (kind, path = at) => {
        if (out.length < 50) out.push({ path, kind });
    };
    const unsupported = (v) =>
        (v !== null && typeof v === "object" && !isPlain(v) && !Array.isArray(v) && !isBinary(v)) ||
        typeof v === "function" ||
        typeof v === "symbol";
    if (unsupported(a) || unsupported(b)) {
        add("unsupported type");
        return out;
    }
    if (isBinary(a) || isBinary(b)) {
        if (!isBinary(a) || !isBinary(b)) add("type");
        else if (
            !Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
        )
            add("bytes");
        return out;
    }
    if (typeof a !== typeof b) {
        add([typeof a, typeof b].sort().join("/") === "bigint/number" ? "int64" : "type");
        return out;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) add("type");
        else {
            if (a.length !== b.length) add("length");
            for (let i = 0; i < Math.max(a.length, b.length) && out.length < 50; i++) {
                if (Object.hasOwn(a, i) !== Object.hasOwn(b, i)) add("missing-key", `${at}[${i}]`);
                else differences(a[i], b[i], `${at}[${i}]`, out);
            }
        }
        return out;
    }
    if (isPlain(a) || isPlain(b)) {
        if (!isPlain(a) || !isPlain(b)) {
            add("type");
            return out;
        }
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (out.length >= 50) break;
            if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) add("missing-key", `${at}.${key}`);
            else differences(a[key], b[key], `${at}.${key}`, out);
        }
        return out;
    }
    if (!Object.is(a, b)) add("value");
    return out;
}

/** Detailed paths are synthetic-only; private files get bounded counts grouped by fixed kinds. */
function describeDifferences(diffs, detailed) {
    if (detailed) return diffs.map(({ path, kind }) => `${path}: ${kind}`);
    const counts = new Map();
    for (const { kind } of diffs) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return [...counts].map(([kind, count]) => `${kind}: ${count} difference(s) (first 50 differences)`);
}

// ---------------------------------------------------------------------------------------------------
// Reading a `.bin`

/**
 * Indexes `file` with the server's strict archive reader and returns the record layout and the decoded
 * database, read once by upstream's decoder and once by this server's. `assets` maps record names to
 * bytes only when `keepAssets` (synthetic checks).
 */
async function readBin(upstream, file, { keepAssets = false, detailed = false } = {}) {
    const problems = [];
    const handle = await open(file, "r");
    try {
        const records = await indexArchive(handle);
        const names = records.map((r) => r.name);
        const databases = records.filter((r) => r.name === "database.risudat");
        if (databases.length !== 1) problems.push(`${databases.length} database.risudat records`);
        if (records.at(-1)?.name !== "database.risudat") problems.push("database.risudat is not the last record");
        if (new Set(names).size !== names.length) problems.push("duplicate record names");
        if (names.some((n) => n.includes("/") || n.includes("\\")))
            problems.push("a record name with a path separator");
        if (names.includes("encryption.risudat")) problems.push("an encryption.risudat record");
        const cold = names.filter((n) =>
            /^(coldstorage_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(n),
        );
        const assets = new Map();
        if (keepAssets) {
            for (const record of records)
                if (record.name !== "database.risudat") assets.set(record.name, await readRecord(handle, record));
        }
        if (databases.length !== 1) return { problems, records: records.length, cold: cold.length, assets };
        if (databases[0].length > MAX_DECODED_BYTES) throw new Error("database record exceeds the decode limit");
        const bytes = await readRecord(handle, databases[0]);
        const ours = decodeUpstreamDatabase(bytes, { maxDecodedBytes: MAX_DECODED_BYTES });
        const decoded = await runPhase(upstream.harness, "decode", () =>
            upstream.decodeRisuSave(new Uint8Array(bytes)),
        );
        if (decoded.threw) problems.push("upstream decodeRisuSave threw");
        const logged = Object.entries(decoded.consoleCounts).filter(([, n]) => n > 0);
        if (logged.length > 0)
            problems.push(
                `upstream decode wrote to the console (${logged.map(([m, n]) => `${m} ${n}`).join(", ")}): a fallback path ran`,
            );
        if (decoded.uses.length > 0)
            problems.push(
                detailed
                    ? `upstream decode used stubs: ${decoded.uses.map((u) => u.label).join(", ")}`
                    : `upstream decode used stubs: ${decoded.uses.length}`,
            );
        if (!decoded.threw) {
            for (const diff of describeDifferences(differences(decoded.value, ours), detailed))
                problems.push(`upstream vs this server's decoder: ${diff}`);
        }
        return { problems, records: records.length, cold: cold.length, assets, db: decoded.value, ours };
    } finally {
        await handle.close();
    }
}

// ---------------------------------------------------------------------------------------------------
// Upstream boot pass

const chatsOf = (character) => (Array.isArray(character?.chats) ? character.chats : []);
/** Character identity and ordered chat/message content, separate from boot-assigned chat ids. */
const contentOf = (db) =>
    (db.characters ?? []).map((c) => ({
        chaId: c?.chaId,
        chats: chatsOf(c).map((chat) => ({
            messages: (Array.isArray(chat?.message) ? chat.message : []).map((m) => [
                m?.role,
                m?.data,
                m?.saying ?? "",
            ]),
        })),
    }));

/**
 * Upstream's boot after a restore, in its order: `setDatabase(decoded)`, `checkNewFormat()` (which calls
 * `setDatabase` and `checkCharOrder` again), then `assignIds()`. `makeColdData` and `cleanChunks` are
 * not run (upstream storage I/O). Returns problems as fixed categories.
 */
async function bootPass(upstream, decoded, { detailed = false } = {}) {
    const db = structuredClone(decoded);
    const before = contentOf(db);
    const beforeIds = (db.characters ?? []).map((c) => chatsOf(c).map((chat) => chat?.id));
    const run = await runPhase(upstream.harness, "boot", async () => {
        upstream.harness.DBState.db = db;
        upstream.setDatabase(db);
        await upstream.checkNewFormat();
        upstream.assignIds();
        return upstream.harness.DBState.db;
    });
    const problems = [];
    if (run.threw) problems.push("the boot pass threw");
    if (run.consoleCounts.error > 0 || run.consoleCounts.warn > 0) {
        problems.push(`the boot pass logged ${run.consoleCounts.error} errors and ${run.consoleCounts.warn} warnings`);
    }
    const unapproved = run.uses.filter((u) => !BOOT_APPROVED.has(u.label));
    if (unapproved.length > 0)
        problems.push(
            detailed
                ? `stub uses in the boot pass: ${[...new Set(unapproved.map((u) => u.label))].join(", ")}`
                : `stub uses in the boot pass: ${unapproved.length}`,
        );
    const after = run.value;
    if (!after) return { problems, db: undefined };
    for (const diff of describeDifferences(differences(before, contentOf(after)), detailed))
        problems.push(`characters, chats or messages changed: ${diff}`);
    // Upstream assigns absent chat ids, including the exporter's empty first chat. Existing ids
    // must survive at the same position; every resulting id must be usable and globally unique.
    const chatIds = new Set();
    for (const [ci, c] of after.characters.entries()) {
        for (const [i, chat] of chatsOf(c).entries()) {
            const previous = beforeIds[ci]?.[i];
            if (previous !== undefined && chat.id !== previous) problems.push("an existing chat id changed");
            if (typeof chat.id !== "string" || chat.id.length === 0)
                problems.push("a chat id is not a non-empty string");
            else if (chatIds.has(chat.id)) problems.push("duplicate chat ids after boot");
            else chatIds.add(chat.id);
        }
    }
    if (!Array.isArray(after.botPresets) || after.botPresets.length === 0) problems.push("botPresets empty after boot");
    if (after.formatversion !== 5) problems.push("formatversion is not 5 after boot");
    for (const c of after.characters) {
        if (!Array.isArray(c.chats) || c.chats.length === 0) problems.push("a character without chats");
        if (c.chats?.some((chat) => !Array.isArray(chat.message))) problems.push("a chat without a message array");
        if (!c.chats?.[c.chatPage ?? 0]) problems.push("a character whose chatPage names no chat");
    }
    const ordered = new Set(
        (after.characterOrder ?? []).flatMap((entry) => (typeof entry === "string" ? [entry] : (entry?.data ?? []))),
    );
    const missing = after.characters.filter((c) => !c.trashTime && !ordered.has(c.chaId));
    if (missing.length > 0) problems.push(`${missing.length} characters missing from characterOrder`);
    return { problems, db: after };
}

const countsOf = (db) => {
    const characters = Array.isArray(db.characters) ? db.characters : [];
    const chats = characters.flatMap(chatsOf);
    return {
        characters: characters.length,
        groups: characters.filter((c) => c?.type === "group").length,
        chats: chats.length,
        messages: chats.reduce((n, chat) => n + (Array.isArray(chat?.message) ? chat.message.length : 0), 0),
        botPresets: Array.isArray(db.botPresets) ? db.botPresets.length : 0,
        personas: Array.isArray(db.personas) ? db.personas.length : 0,
        modules: Array.isArray(db.modules) ? db.modules.length : 0,
        plugins: Array.isArray(db.plugins) ? db.plugins.length : 0,
    };
};
const formatCounts = (counts) =>
    Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");

// ---------------------------------------------------------------------------------------------------
// Check 1: S1's encoder read by upstream's decoder

/** Values the codec must carry exactly: wide and negative integers, floats, bytes, long non-ASCII text. */
function edgeCaseDatabase() {
    return {
        formatversion: 5,
        characters: [],
        wide: 2 ** 40 + 3,
        maxSafe: Number.MAX_SAFE_INTEGER,
        negativeWide: -(2 ** 35) - 7,
        negativeSmall: -5,
        uint32: 4294967295,
        float: 0.1,
        bytes: Uint8Array.from([0, 1, 2, 127, 128, 255]),
        emptyBytes: new Uint8Array(0),
        korean: "가나다라마바사".repeat(12),
        emoji: "🌸".repeat(40),
        longAscii: "x".repeat(70_000),
        nested: { u: undefined, n: null, t: true, f: false, a: [], o: {}, deep: [[[{ x: [1, "2", true, null] }]]] },
        longArray: Array.from({ length: 70_000 }, (_, i) => i * 3),
        manyKeys: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])),
    };
}

async function checkEncoder(upstream) {
    for (const [name, input] of [
        ["codec fixture", UPSTREAM_FIXTURE_DATABASE],
        ["edge cases", edgeCaseDatabase()],
    ]) {
        const bytes = encodeUpstreamDatabase(input);
        const run = await runPhase(upstream.harness, "decode", () => upstream.decodeRisuSave(bytes));
        const problems = [];
        if (run.threw) problems.push(`upstream decodeRisuSave threw: ${run.error?.message ?? run.error}`);
        const logged = Object.entries(run.consoleCounts).filter(([, n]) => n > 0);
        if (logged.length > 0)
            problems.push(`console output during decode (${logged.map(([m]) => m).join(", ")}): a fallback path ran`);
        if (run.uses.length > 0) problems.push(`stub uses: ${run.uses.map((u) => u.label).join(", ")}`);
        if (!run.threw) problems.push(...describeDifferences(differences(input, run.value), true));
        report(`encoder → upstream decoder (${name})`, problems, `${bytes.length} bytes`);
    }
}

// ---------------------------------------------------------------------------------------------------
// Check 2: the export of a synthetic library

const SENTINEL_KEY = "sk-checkbincompat-sentinel-0123456789abcdef";
const FIXTURE_CHARACTER = UPSTREAM_FIXTURE_DATABASE.characters[0].chaId;
const FIXTURE_GROUP = UPSTREAM_FIXTURE_DATABASE.characters[1].chaId;
const SECOND = "5d1c2b3a-4f5e-4d6c-8b7a-9f8e7d6c5b4a";
const SECOND_CHATS = ["7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", "8b7c6d5e-4f3a-4b2c-8d9e-0f1a2b3c4d5e"];
const TRASHED = "9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f";
const FOLDER = "f0e1d2c3-b4a5-4968-8776-655443322110";
const MODULE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e";
const DAY = 24 * 60 * 60 * 1000;

const message = (role, data, time, extra = {}) => ({ role, data, saying: "", time, chatId: randomUUID(), ...extra });

/**
 * The input library: upstream-shaped, made up for this check (no user data, a sentinel key). The codec
 * fixture plus a character with lore, two chats (one with chat toggles), a folder, a character trashed
 * 10 days ago (upstream's boot deletes trash older than 3 days), a module with lore, a second preset and
 * a second persona.
 */
function syntheticLibrary(now) {
    const db = structuredClone(UPSTREAM_FIXTURE_DATABASE);
    db.characters.push(
        {
            type: "character",
            chaId: SECOND,
            name: "Second character",
            desc: "A made-up character for the export check.",
            firstMessage: "Hello from the second character.",
            image: "assets/second.png",
            emotionImages: [["calm", "assets/calm.png"]],
            bias: [],
            viewScreen: "none",
            globalLore: [
                {
                    key: "castle",
                    secondkey: "",
                    insertorder: 100,
                    comment: "castle",
                    content: "The castle has four towers.",
                    mode: "normal",
                    alwaysActive: false,
                    selective: false,
                },
            ],
            chatPage: 0,
            chats: [
                {
                    id: SECOND_CHATS[0],
                    name: "Morning",
                    note: "",
                    localLore: [],
                    fmIndex: -1,
                    message: [
                        message("user", "Good morning", now - 3 * DAY),
                        message("char", "Good morning to you.", now - 3 * DAY + 1000),
                    ],
                },
                {
                    id: SECOND_CHATS[1],
                    name: "Evening",
                    note: "A chat note.",
                    localLore: [],
                    fmIndex: -1,
                    GLGlobalVariables: { toggle_mode: "1" },
                    useLocallySetGlobalVariables: true,
                    message: [
                        message("user", "Good evening", now - DAY),
                        message("char", "Good evening, {{user}}.", now - DAY + 1000),
                    ],
                },
            ],
        },
        {
            type: "character",
            chaId: TRASHED,
            name: "Trashed character",
            desc: "",
            firstMessage: "",
            image: "",
            emotionImages: [],
            bias: [],
            viewScreen: "none",
            globalLore: [],
            trashTime: now - 10 * DAY,
            chatPage: 0,
            chats: [
                {
                    id: randomUUID(),
                    name: "Old chat",
                    note: "",
                    localLore: [],
                    fmIndex: -1,
                    message: [message("user", "Old", now - 20 * DAY)],
                },
            ],
        },
    );
    db.characters.find((c) => c.chaId === SECOND).chats[0].localLore = [
        { ...db.characters[0].globalLore[0], key: "morning", comment: "Local lore", content: "It is morning." },
    ];
    db.characterOrder = [{ id: FOLDER, name: "Folder", color: "", data: [SECOND] }, FIXTURE_CHARACTER, FIXTURE_GROUP];
    db.modules = [
        {
            name: "Synthetic module",
            description: "A made-up module.",
            id: MODULE,
            lorebook: [
                {
                    key: "tower",
                    secondkey: "",
                    insertorder: 100,
                    comment: "tower",
                    content: "Towers are tall.",
                    mode: "normal",
                    alwaysActive: false,
                    selective: false,
                },
            ],
            regex: [],
            trigger: [],
        },
    ];
    db.enabledModules = [MODULE];
    db.botPresets.push({
        ...structuredClone(db.botPresets[0]),
        name: "Second preset",
        mainPrompt: "Second preset prompt.",
        temperature: 65,
        maxResponse: 750,
    });
    db.botPresetsId = 1;
    db.mainPrompt = "Second preset prompt.";
    db.personas.push({ name: "Traveler", personaPrompt: "A traveler persona.", icon: "assets/second.png", note: "" });
    db.selectedPersona = 1;
    db.username = "Traveler";
    db.personaPrompt = "A traveler persona.";
    db.openAIKey = SENTINEL_KEY;
    return db;
}

/** Asset records the library's archive carries, by basename (every `assets/...` key it references). */
const LIBRARY_ASSETS = {
    "3f2a9c.png": Buffer.from("synthetic PNG: fixture profile"),
    "joy.png": Buffer.from("synthetic PNG: fixture emotion"),
    "second.png": Buffer.from("synthetic PNG: second profile"),
    "calm.png": Buffer.from("synthetic PNG: second emotion"),
};

async function ndjson(res) {
    const text = await res.text();
    if (res.status !== 200) throw new Error(`prepare answered ${res.status}`);
    return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

/** The import through this server's routes (in-process stage), then two exports, written to `dir`. */
async function exportLibrary(library, dir) {
    const s = await createResourceTestClient({
        upstreamImport: { runner: (input, { onProgress }) => stageUpstreamImport(input, onProgress) },
    });
    try {
        const archive = buildArchive([
            ...Object.entries(LIBRARY_ASSETS),
            ["database.risudat", encodeUpstreamDatabase(library)],
        ]);
        const lines = await ndjson(
            await s.request(UPSTREAM_IMPORT_PREPARE_PATH, {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: archive,
            }),
        );
        const prepared = lines.at(-1);
        if (!prepared?.token) throw new Error(`the import prepare failed: ${JSON.stringify(prepared)}`);
        const committed = await s.json(UPSTREAM_IMPORT_COMMIT_PATH, { token: prepared.token });
        if (committed.status !== 200) throw new Error(`the import commit answered ${committed.status}`);
        await s.readEpoch();
        const files = {};
        for (const includeSecrets of [false, true]) {
            const res = await s.json(UPSTREAM_EXPORT_PREPARE_PATH, {
                ...prepared.selection,
                includeSecrets,
                selectedChat: { characterId: SECOND, chatId: SECOND_CHATS[1] },
            });
            if (res.status !== 200) throw new Error(`the export prepare answered ${res.status}: ${await res.text()}`);
            const { token, report: exportReport } = await res.json();
            const download = await s.request(`${UPSTREAM_EXPORT_DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`);
            if (download.status !== 200) throw new Error(`the export download answered ${download.status}`);
            const file = path.join(dir, `export-${includeSecrets ? "keys" : "nokeys"}.bin`);
            writeFileSync(file, new Uint8Array(await download.arrayBuffer()));
            files[includeSecrets ? "keys" : "noKeys"] = { file, report: exportReport };
        }
        return { importReport: prepared.report, files };
    } finally {
        await s.close();
    }
}

const byId = (list, key) => new Map((list ?? []).map((item) => [item?.[key], item]));
const loreOf = (list) =>
    (list ?? []).map((entry) => [
        entry.key,
        entry.secondkey,
        entry.insertorder,
        entry.comment,
        entry.content,
        entry.mode,
        entry.alwaysActive,
        entry.selective,
    ]);
const messagesOf = (chat) => (chat.message ?? []).map((m) => [m.role, m.data, m.saying ?? "", m.time]);
const orderOf = (list) =>
    (list ?? []).map((entry) =>
        typeof entry === "string" ? entry : { id: entry.id, name: entry.name, data: entry.data },
    );

/**
 * The exported database against the input library, under the export's documented conversions:
 * chats and messages in order, lore, groups, folders, selections, the trash refresh, modules, and the
 * key only with `includeSecrets`. Allowances: refreshed expired trash, chat-local toggles enabling
 * `useLocallySetGlobalVariables`, generated ids for input messages without chatId, and selection roots
 * projected from the selected chat, prompt preset and persona rather than copied from stale roots.
 */
function compareWithLibrary(library, exported, { includeSecrets, rawBytes }) {
    const problems = [];
    const expect = (ok, problem) => ok || problems.push(problem);
    const same = (a, b) => differences(a, b).length === 0;
    const out = byId(exported.characters, "chaId");
    expect(
        JSON.stringify([...out.keys()].sort()) === JSON.stringify(library.characters.map((c) => c.chaId).sort()),
        "the exported characters are not the library's",
    );
    for (const input of library.characters) {
        const got = out.get(input.chaId);
        if (!got) continue;
        const who = input.name;
        for (const field of ["type", "name", "desc", "firstMessage", "image"]) {
            if (input[field] !== undefined) expect(got[field] === input[field], `${who}: ${field} differs`);
        }
        if (input.emotionImages)
            expect(
                JSON.stringify(got.emotionImages) === JSON.stringify(input.emotionImages),
                `${who}: emotionImages differ`,
            );
        expect(same(loreOf(got.globalLore), loreOf(input.globalLore)), `${who}: lore differs`);
        if (input.type === "group") {
            expect(JSON.stringify(got.characters) === JSON.stringify(input.characters), `${who}: members differ`);
            expect(
                same(got.characterTalks, input.characterTalks) && same(got.characterActive, input.characterActive),
                `${who}: talk/active values differ`,
            );
        }
        expect(
            JSON.stringify(chatsOf(got).map((chat) => chat.id)) ===
                JSON.stringify(chatsOf(input).map((chat) => chat.id)),
            `${who}: chat ids or order differ`,
        );
        for (const [i, chat] of chatsOf(input).entries()) {
            const gotChat = chatsOf(got)[i];
            if (!gotChat) continue;
            expect(gotChat.name === chat.name, `${who} chat ${i}: name differs`);
            expect(gotChat.note === chat.note, `${who} chat ${i}: note differs`);
            expect(same(loreOf(gotChat.localLore), loreOf(chat.localLore)), `${who} chat ${i}: local lore differs`);
            expect(same(messagesOf(gotChat), messagesOf(chat)), `${who} chat ${i}: messages differ`);
            for (const [j, m] of (chat.message ?? []).entries()) {
                const id = gotChat.message[j]?.chatId;
                expect(typeof id === "string" && id.length > 0, `${who} chat ${i} message ${j}: chatId missing`);
                if (m.chatId !== undefined) expect(id === m.chatId, `${who} chat ${i} message ${j}: chatId differs`);
            }
            if (chat.GLGlobalVariables) {
                expect(same(gotChat.GLGlobalVariables, chat.GLGlobalVariables), `${who} chat ${i}: toggles differ`);
                expect(
                    gotChat.useLocallySetGlobalVariables === true,
                    `${who} chat ${i}: useLocallySetGlobalVariables not set`,
                );
            }
        }
        if (input.trashTime) expect(got.trashTime > Date.now() - 3 * DAY, `${who}: expired trash time not refreshed`);
    }
    const second = out.get(SECOND);
    expect(second?.chatPage === 1, "chatPage does not name the selected chat");
    expect(same(orderOf(exported.characterOrder), orderOf(library.characterOrder)), "characterOrder differs");

    expect(
        JSON.stringify(exported.botPresets?.map((p) => p.name)) ===
            JSON.stringify(library.botPresets.map((p) => p.name)),
        "prompt preset names or order differ",
    );
    expect(
        exported.botPresets?.[exported.botPresetsId]?.name === "Second preset",
        "botPresetsId is not the selected preset",
    );
    for (const [i, preset] of library.botPresets.entries()) {
        for (const field of PROMPT_PRESET_FIELDS) {
            if (Object.hasOwn(preset, field))
                expect(same(exported.botPresets?.[i]?.[field], preset[field]), `preset ${i}: ${field} differs`);
        }
    }
    expect(exported.mainPrompt === "Second preset prompt.", "the root main prompt is not the selected preset's");

    expect(
        JSON.stringify(exported.personas?.map((p) => [p.name, p.personaPrompt, p.icon])) ===
            JSON.stringify(library.personas.map((p) => [p.name, p.personaPrompt, p.icon])),
        "persona names, prompts or icons differ",
    );
    expect(exported.selectedPersona === 1, "selectedPersona is not the selected persona");
    expect(
        exported.username === "Traveler" && exported.personaPrompt === "A traveler persona.",
        "the root persona fields are not the selected persona's",
    );

    expect(
        same((exported.modules ?? []).map((m) => m.id).sort(), library.modules.map((m) => m.id).sort()),
        "module membership differs",
    );
    const modules = byId(exported.modules, "id");
    for (const input of library.modules) {
        const got = modules.get(input.id);
        expect(got?.name === input.name, "module name differs or module missing");
        expect(same(loreOf(got?.lorebook), loreOf(input.lorebook)), "module lore differs");
        expect(same(got?.regex, input.regex), "module regex differs");
        expect(same(got?.trigger, input.trigger), "module trigger differs");
    }
    expect(same(exported.enabledModules, library.enabledModules), "enabledModules differ");

    const sentinelInBytes = rawBytes.includes(Buffer.from(SENTINEL_KEY));
    const sentinelInDb = JSON.stringify(exported).includes(SENTINEL_KEY);
    if (includeSecrets) expect(exported.openAIKey === SENTINEL_KEY, "the API key is missing with includeSecrets");
    else expect(!sentinelInBytes && !sentinelInDb, "the API key is in an export without includeSecrets");
    return problems;
}

async function checkExport(upstream) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-bin-compat-"));
    try {
        const library = syntheticLibrary(Date.now());
        const { files } = await exportLibrary(library, dir);
        for (const [variant, { file }] of Object.entries(files)) {
            const includeSecrets = variant === "keys";
            const bin = await readBin(upstream, file, { keepAssets: true, detailed: true });
            const problems = [...bin.problems];
            if (bin.db) {
                problems.push(...compareWithLibrary(library, bin.db, { includeSecrets, rawBytes: readFileSync(file) }));
                for (const [name, bytes] of Object.entries(LIBRARY_ASSETS)) {
                    const got = bin.assets.get(name);
                    if (!got) problems.push(`asset record ${name} missing`);
                    else if (!got.equals(bytes)) problems.push(`asset record ${name}: bytes differ`);
                }
                if (bin.assets.size !== Object.keys(LIBRARY_ASSETS).length)
                    problems.push(`${bin.assets.size} asset records, expected ${Object.keys(LIBRARY_ASSETS).length}`);
            }
            report(
                `export → upstream decoder (${includeSecrets ? "with" : "without"} API keys)`,
                problems,
                bin.db ? formatCounts(countsOf(bin.db)) : "",
            );
            if (bin.db) {
                const boot = await bootPass(upstream, bin.db, { detailed: true });
                report(
                    `upstream boot pass on the export (${includeSecrets ? "with" : "without"} API keys)`,
                    boot.problems,
                    boot.db ? formatCounts(countsOf(boot.db)) : "",
                );
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------------------
// --bin: an existing file, counts and categories only

async function checkFile(upstream, file, ordinal) {
    let bin;
    try {
        bin = await readBin(upstream, file);
    } catch {
        fail(`--bin #${ordinal}`, ["the archive could not be read (not a .bin, or damaged)"]);
        return;
    }
    const counts = `records ${bin.records}, cold records ${bin.cold}${bin.db ? `, ${formatCounts(countsOf(bin.db))}` : ""}`;
    report(`--bin #${ordinal}: upstream decoder`, bin.problems, counts);
    if (bin.db) {
        let boot;
        try {
            boot = await bootPass(upstream, bin.db);
        } catch {
            boot = { problems: ["the boot check could not be completed"] };
        }
        report(`--bin #${ordinal}: upstream boot pass`, boot.problems, boot.db ? formatCounts(countsOf(boot.db)) : "");
    }
}

// ---------------------------------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "usage: RISU_UPSTREAM_DIR=... RISU_UPSTREAM_MSGPACKR=... RISU_UPSTREAM_FFLATE=... node util/upstream/checkBinCompat.mjs [--bin <file.bin>]...",
        );
        return;
    }
    const bins = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--bin" && argv[i + 1]) bins.push(path.resolve(argv[++i]));
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    const upstream = await loadUpstream({
        upstreamDir: process.env.RISU_UPSTREAM_DIR,
        msgpackrDir: process.env.RISU_UPSTREAM_MSGPACKR,
        fflateDir: process.env.RISU_UPSTREAM_FFLATE,
    });
    console.log(
        `upstream ${UPSTREAM_COMMIT.slice(0, 8)}: ${upstream.realModules.length} modules loaded as written, extracted ${upstream.extracted.join("; ")}, ${upstream.stubbedModules.length} modules stubbed`,
    );
    const unapprovedLoad = upstream.load.uses.filter((u) => !LOAD_APPROVED.has(u.label));
    const loadProblems = unapprovedLoad.map((u) => `unapproved stub use while loading: ${u.label}`);
    if (upstream.load.consoleCounts.error > 0 || upstream.load.consoleCounts.warn > 0)
        loadProblems.push(
            `upstream modules logged ${upstream.load.consoleCounts.error} errors and ${upstream.load.consoleCounts.warn} warnings`,
        );
    report("upstream modules load", loadProblems);
    if (bins.length === 0) {
        await checkEncoder(upstream);
        await checkExport(upstream);
    }
    for (const [i, file] of bins.entries()) await checkFile(upstream, file, i + 1);
    console.log(failures === 0 ? "OK" : `${failures} check(s) failed`);
    console.log(
        "Not run (upstream code outside the check): LoadLocalBackup's reader and asset writes, makeColdData, cleanChunks, plugins, the UI.",
    );
    process.exitCode = failures === 0 ? 0 : 1;
}

try {
    await main();
} catch (error) {
    // Even an unexpected exception must not expose a private input's name, keys or content.
    console.log(
        process.argv.includes("--bin")
            ? "ERROR setup or file check failed"
            : `ERROR ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
}
