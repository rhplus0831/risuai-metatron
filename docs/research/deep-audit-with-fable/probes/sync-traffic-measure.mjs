import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../server/src/data/kinds.ts";
import { createResourceStore } from "../../../../server/src/data/resourceStore.ts";
import { parseBootRequest, readBoot } from "../../../../server/src/routes/resourceBoot.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const store = createResourceStore({ file: ":memory:", kinds });
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
} finally {
    store.close();
}
