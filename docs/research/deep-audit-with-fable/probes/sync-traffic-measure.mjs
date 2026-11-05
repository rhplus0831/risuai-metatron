// Boot/listing/operation sizes, followed by deterministic mixed-write change-feed measurements.
// Run from the repository root with node; PROBE_COMMIT labels the measured production source.
// The mixed fixture appends 1,536 ASCII characters (about three seconds of streaming) 45 times,
// writes final generationInfo, makes small edits, pastes 96 KiB, replaces the chat as an import,
// and sets three 32 KiB reroll candidates whole three times. Reappend and no-op groups are counted too.
// Each fixture reports body forms and body-less causes over its published-entry denominator;
// attempted groups and unpublished groups are separate. Independent writes cannot exhaust the
// publication budget, so body-less by-id changes in these fixtures are known over-cap entries.
// Each over-cap entry reports its row manifest and the raw/gzip bytes of its row read and whole-chat alternative.
// Body properties are discovered at runtime, keeping this probe runnable on older production sources.
import { execFileSync } from "node:child_process";
import { createChangeFeed } from "../../../../server/src/data/changeFeed.ts";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../server/src/data/kinds.ts";
import { createResourceStore } from "../../../../server/src/data/resourceStore.ts";
import { parseBootRequest, readBoot } from "../../../../server/src/routes/resourceBoot.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const feed = createChangeFeed();
const store = createResourceStore({ file: ":memory:", kinds, feed });
const commit = process.env.PROBE_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
let observedEntries = null;
feed.subscribe((event) => {
    if (event.type === "change" && observedEntries) observedEntries.push(...event.changes.chats);
});
const size = (value) => Buffer.byteLength(JSON.stringify(value));
const packed = (value) => gzipSync(JSON.stringify(value), { level: 1 }).length;
const text = (n) => "A character remembers the moon and speaks softly. ".repeat(Math.ceil(n / 49)).slice(0, n);
const asset = () => `assets/${randomUUID().replaceAll("-", "").repeat(2)}.png`;
const ids = Array.from({ length: 300 }, () => randomUUID());
const pid = randomUUID(),
    mid = randomUUID(),
    person = randomUUID();
try {
    for (let c = 0; c < 300; c++) {
        const chaId = ids[c];
        const char = {
            chaId,
            name: `Character ${c}`,
            desc: text(8192),
            firstMessage: text(2048),
            globalLore: Array.from({ length: 100 }, (_, i) => ({ key: `lore-${i}`, content: text(1024) })),
            additionalAssets: Array.from({ length: 100 }, (_, i) => [`asset-${i}`, asset(), "png"]),
            emotionImages: Array.from({ length: 20 }, (_, i) => [`emotion-${i}`, asset()]),
        };
        store.applyChanges({
            ops: [{ kind: kinds.get("characters"), id: chaId, baseRevision: null, data: char }],
            chats: Array.from({ length: 10 }, (_, j) => ({
                characterId: chaId,
                chatId: randomUUID(),
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            name: `Chat ${j}`,
                            fmIndex: -1,
                            bindedPersona: person,
                            promptPresetId: pid,
                            modelPresetId: mid,
                            message:
                                c === 0 && j === 0
                                    ? Array.from({ length: 2000 }, () => ({
                                          chatId: randomUUID(),
                                          role: "user",
                                          data: text(2048),
                                      }))
                                    : [],
                        },
                    },
                ],
            })),
        });
    }
    const put = (kind, data) =>
        store.applyChanges({
            ops: [{ kind: kinds.get(kind), id: "main", baseRevision: store.revisionOf(kinds.get(kind), "main"), data }],
        });
    put(
        "presets",
        Array.from({ length: 50 }, (_, i) => ({
            id: randomUUID(),
            name: `Preset ${i}`,
            mainPrompt: text(16384),
            jailbreak: text(8192),
        })),
    );
    put(
        "modules",
        Array.from({ length: 20 }, (_, i) => ({
            id: randomUUID(),
            name: `Module ${i}`,
            lorebook: Array.from({ length: 300 }, (_, j) => ({ key: `lore-${j}`, content: text(1024) })),
            assets: Array.from({ length: 500 }, (_, j) => [`asset-${j}`, asset(), "png"]),
        })),
    );
    put(
        "plugins",
        Array.from({ length: 10 }, (_, i) => ({
            name: `Plugin ${i}`,
            script: text(102400),
            enabled: true,
            realArg: { key: "v" },
        })),
    );
    put("pluginStorage", { _pluginStorage: { history: Array.from({ length: 1000 }, () => text(2048)), counter: 1 } });
    console.log(
        JSON.stringify(
            {
                commit,
                recordDataBytes: Object.fromEntries(
                    ["presets", "modules", "plugins", "pluginStorage"].map((k) => [
                        k,
                        size(store.get(kinds.get(k), "main").data),
                    ]),
                ),
                moduleLoreBytes: size(store.get(kinds.get("modules"), "main").data[0].lorebook),
                moduleAssetsBytes: size(store.get(kinds.get("modules"), "main").data[0].assets),
            },
            null,
            2,
        ),
    );
    const base = { kinds: Object.values(RESOURCE_KIND), chatSummaries: true };
    const project = (kind, data) => (kind.project ? kind.project(data) : data);
    const cold = readBoot(store, parseBootRequest(base, kinds), project);
    const known = { records: [], items: [] };
    for (const name of ["characters", "presets", "modules"])
        for (const r of cold.kinds[name]) {
            known.records.push({ kind: name, id: r.id, revision: r.revision });
            if (r.items) known.items.push({ kind: name, hashes: r.items.map((i) => i.hash) });
        }
    const warm = readBoot(store, parseBootRequest({ ...base, known }, kinds), project);
    const listing = store.listRevisions();
    const long = store.readRefs([], { chats: [{ characterId: ids[0], id: cold.chatSummaries[0].id }] }).chats[0];
    const summaryCollection = store.readRefs([], { chatSummaryCollections: [ids[0]] });
    const first = cold.kinds.characters[0];
    console.log(
        JSON.stringify(
            {
                commit,
                node: process.version,
                counts: {
                    characters: ids.length,
                    chats: cold.chatSummaries.length,
                    resources: listing.resources.length,
                },
                coldRequest: size(base),
                warmRequest: size({ ...base, known }),
                coldResponse: size(cold),
                coldGzip1: packed(cold),
                warmResponse: size(warm),
                warmGzip1: packed(warm),
                revisionListing: size(listing),
                revisionListingGzip1Hypothetical: packed(listing),
                summaries: size(cold.chatSummaries),
                orders: size(cold.chatOrders),
                summaryCollection10: size(summaryCollection),
                oneCharacter: size(first),
                longChatRead: size(long),
                characterPayloadTotal: size(cold.kinds.characters),
                presets: size(cold.kinds.presets),
                modules: size(cold.kinds.modules),
                plugins: size(cold.kinds.plugins),
                pluginStorage: size(cold.kinds.pluginStorage),
            },
            null,
            2,
        ),
    );
    store.applyChanges({
        ops: [
            {
                kind: kinds.get("characters"),
                id: first.id,
                baseRevision: first.revision,
                patch: { set: { lastInteraction: 1792990000000 } },
            },
        ],
    });
    const warmChanged = readBoot(store, parseBootRequest({ ...base, known }, kinds), project);
    const trans = { sourceHash: "a".repeat(14), text: text(2048), targetLanguage: "ko", translatedAt: 1792990000000 };
    console.log(
        JSON.stringify(
            {
                commit,
                warmAfterOneCharacterTimestamp: size(warmChanged),
                extra: size(warmChanged) - size(warm),
                oneMsgSetText: size({ op: "setText", id: randomUUID(), text: text(2048) }),
                oneRemove: size({ op: "remove", ids: [randomUUID()] }),
                remove100: size({ op: "remove", ids: Array.from({ length: 100 }, () => randomUUID()) }),
                chatReplace: size({ op: "replace", chat: long.data }),
                translation: size({ op: "setTranslation", id: randomUUID(), translation: trans }),
            },
            null,
            2,
        ),
    );
    const characterId = ids[0];
    const chatId = "mixed-transport";
    const chunk = "The reply grows in a deterministic stream. ".repeat(40).slice(0, 1536);
    const group = (ops) => ({ characterId, chatId, baseRevision: store.chatRevision(characterId, chatId), ops });
    store.applyChanges({
        chats: [
            group([
                {
                    op: "create",
                    chat: {
                        id: chatId,
                        name: "Mixed transport",
                        message: [
                            { chatId: "user", role: "user", data: "A question" },
                            { chatId: "reply", role: "char", data: "" },
                            { chatId: "carrier", role: "char", data: "Reroll" },
                        ],
                    },
                },
            ]),
        ],
    });
    const emptyCounts = () => ({
        attemptedGroups: 0,
        publishedEntries: 0,
        unpublishedGroups: 0,
        bodies: { patch: 0, delta: 0, rowDelta: 0 },
        bodyless: { overCap: 0, wholeChatWrite: 0, reappendOrNoop: 0, budgetDrop: 0 },
        bodyBytes: 0,
        overCapReads: [],
    });
    const fixtures = {};
    const write = (fixture, ops, cause = "overCap") => {
        const counts = (fixtures[fixture] ??= emptyCounts());
        counts.attemptedGroups += 1;
        observedEntries = [];
        const result = store.applyChanges({ chats: [group(ops)] });
        if (!result.chats[0]?.revision) throw new Error(JSON.stringify(result));
        const entries = observedEntries;
        observedEntries = null;
        counts.publishedEntries += entries.length;
        if (entries.length === 0) counts.unpublishedGroups += 1;
        for (const entry of entries) {
            const form = ["patch", "delta", "rowDelta"].find((name) => entry[name]);
            if (form) {
                counts.bodies[form] += 1;
                counts.bodyBytes += size(entry[form]);
            } else {
                counts.bodyless[cause] += 1;
                if (cause === "overCap") {
                    const whole = store.readRefs([], { chats: [{ characterId: entry.characterId, id: entry.id }] });
                    const sample = {
                        rowsManifest: !!entry.rows,
                        wholeChat: { bytes: size(whole), gzip: packed(whole) },
                    };
                    if (entry.rows) {
                        const answer = store.readRefsWithinBudget(
                            [],
                            {
                                chatRows: [
                                    {
                                        characterId: entry.characterId,
                                        id: entry.id,
                                        revision: entry.revision,
                                        messageIds: entry.rows.changed,
                                        meta: entry.rows.meta,
                                    },
                                ],
                            },
                            Number.MAX_SAFE_INTEGER,
                        );
                        sample.chatRows = { bytes: size(answer), gzip: packed(answer) };
                    }
                    counts.overCapReads.push(sample);
                }
            }
        }
    };
    let reply = "";
    for (let i = 0; i < 45; i++) {
        reply += chunk;
        write("appendingCheckpoints", [{ op: "setText", id: "reply", text: reply }]);
    }
    write("finalGenerationInfo", [
        {
            op: "setMessage",
            message: {
                chatId: "reply",
                role: "char",
                data: reply,
                generationInfo: { model: "probe", generationTime: 135 },
            },
        },
    ]);
    for (let i = 0; i < 3; i++) write("smallUserEdits", [{ op: "setText", id: "user", text: `Edited question ${i}` }]);
    write("largePaste", [
        {
            op: "append",
            anchor: { end: true },
            messages: [{ chatId: "paste", role: "user", data: "P".repeat(96 * 1024) }],
        },
    ]);
    const imported = store.readRefs([], { chats: [{ characterId, id: chatId }] }).chats[0].data;
    write("importReplace", [{ op: "replace", chat: { ...imported, name: "Imported transport" } }], "wholeChatWrite");
    for (let i = 0; i < 3; i++)
        write("rerollCandidates", [
            {
                op: "patchMessage",
                id: "carrier",
                set: {
                    candidates: Array.from({ length: 3 }, (_, j) =>
                        `${i}:${j}:`.padEnd(32 * 1024, String.fromCharCode(97 + i + j)),
                    ),
                },
            },
        ]);
    write(
        "reappendOrNoop",
        [
            { op: "remove", ids: ["user"] },
            {
                op: "append",
                anchor: { end: true },
                messages: [{ chatId: "user", role: "user", data: "Reappended question" }],
            },
        ],
        "reappendOrNoop",
    );
    write("reappendOrNoop", [{ op: "remove", ids: ["absent"] }], "reappendOrNoop");
    const total = emptyCounts();
    for (const counts of Object.values(fixtures)) {
        for (const key of ["attemptedGroups", "publishedEntries", "unpublishedGroups", "bodyBytes"])
            total[key] += counts[key];
        total.overCapReads.push(...counts.overCapReads);
        for (const key of Object.keys(total.bodies)) total.bodies[key] += counts.bodies[key];
        for (const key of Object.keys(total.bodyless)) total.bodyless[key] += counts.bodyless[key];
    }
    console.log(
        JSON.stringify(
            {
                label: "mixed-write-feed",
                commit,
                node: process.version,
                fixture: {
                    chunkChars: chunk.length,
                    checkpoints: 45,
                    replyChars: reply.length,
                    pasteChars: 96 * 1024,
                    candidateCount: 3,
                    candidateChars: 32 * 1024,
                    candidateWrites: 3,
                },
                denominator:
                    "Body-form and body-less cause counts divide by publishedEntries; unpublishedGroups divide by attemptedGroups.",
                fixtures,
                total,
            },
            null,
            2,
        ),
    );
} finally {
    store.close();
}
