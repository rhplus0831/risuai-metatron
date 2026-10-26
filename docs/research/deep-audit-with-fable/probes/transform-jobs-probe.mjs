import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../server/src/data/kinds.ts";
import { createResourceStore } from "../../../../server/src/data/resourceStore.ts";
import { createTransformService } from "../../../../server/src/prompt/transform.ts";
import { createScriptWorkerPool } from "../../../../server/src/scripts/workerPool.ts";
import { loadJobScope, scopeChat, jobScopeKinds } from "../../../../server/src/jobs/jobScope.ts";
import { applyTriggerChat } from "../../../../server/src/jobs/chatResult.ts";
import { createGenerationLock } from "../../../../server/src/jobs/generationLock.ts";
import { chatBaseline } from "../../../../server/src/jobs/generationJobs.ts";
import { NO_GENERATION_HOOKS } from "../../../../shared/jobs.ts";

const root = new URL("../../../../", import.meta.url).pathname;
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const lock = createGenerationLock();
const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
const single = (name) => store.get(kinds.get(name), "main").data;
const p = single("presets")[0].id,
    m = single("modelPresets")[0].id,
    u = single("personas")[0].id;
const context = {
    characterId: "c",
    chatId: "k",
    presetId: p,
    modelPresetId: m,
    personaId: u,
    selectedPersonaId: u,
    mode: "transform",
    input: "",
    chatRevision: "",
};
store.put(
    kinds.get("characters"),
    "c",
    {
        chaId: "c",
        type: "character",
        name: "C",
        firstMessage: "hi",
        desc: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
    },
    null,
);
const makeChat = (n, length) => ({
    id: "k",
    name: "K",
    fmIndex: -1,
    promptPresetId: p,
    modelPresetId: m,
    bindedPersona: u,
    scriptstate: { $a: "0" },
    message: Array.from({ length: n }, (_, i) => ({
        chatId: `m${i}`,
        role: i % 2 ? "char" : "user",
        data: `${i}:` + "x".repeat(length),
    })),
});
store.applyChanges({
    chats: [{ characterId: "c", chatId: "k", baseRevision: null, ops: [{ op: "create", chat: makeChat(500, 2048) }] }],
});
const patchChat = (ops) =>
    store.applyChanges({ chats: [{ characterId: "c", chatId: "k", baseRevision: store.chatRevision("c", "k"), ops }] });
const patchChar = (set) =>
    store.applyChanges({
        ops: [
            {
                kind: kinds.get("characters"),
                id: "c",
                baseRevision: store.revisionOf(kinds.get("characters"), "c"),
                patch: { set },
            },
        ],
    });
let counter = null;
const originalParse = JSON.parse;
JSON.parse = function (...args) {
    if (counter) counter.parses++;
    return originalParse.apply(this, args);
};
const scratchDb = new DatabaseSync(":memory:");
const proto = Object.getPrototypeOf(scratchDb.prepare("SELECT 1"));
for (const method of ["get", "all", "iterate"]) {
    const orig = proto[method];
    proto[method] = function (...args) {
        if (counter && /^\s*SELECT/i.test(this.sourceSQL)) counter.selects++;
        return orig.apply(this, args);
    };
}
let luaCalls = 0,
    regexCalls = 0,
    hostCalls = 0;
const workers = createScriptWorkerPool({ rootDir: root });
const countedWorkers = {
    ...workers,
    runLua: (input, options = {}) => {
        luaCalls++;
        return workers.runLua(input, options);
    },
    runScripts: (input, options) => {
        regexCalls++;
        return workers.runScripts(input, {
            ...options,
            host: {
                ...options.host,
                parse: (text) => {
                    hostCalls++;
                    return options.host.parse(text);
                },
            },
        });
    },
};
const deps = { store, kinds, rootDir: root, savePath: root, tokens: {}, llm: {}, scriptWorkers: countedWorkers, lock };
let service = createTransformService(deps);
const signal = new AbortController().signal;
const target = (i, source = `${i}:` + "x".repeat(2048)) => ({
    id: `t${i}`,
    kind: "message",
    sourceId: "c",
    chatIndex: i,
    messageId: `m${i}`,
    source,
});
const request = (targets, extra = {}) => ({
    clientId: "probe",
    mode: "editdisplay",
    context,
    client: { viewport: { width: 800, height: 600 }, browserLanguage: "en" },
    targets,
    ...extra,
});
async function measure(label, fn) {
    counter = { selects: 0, parses: 0 };
    luaCalls = 0;
    regexCalls = 0;
    hostCalls = 0;
    const start = performance.now();
    const value = await fn();
    const counts = counter;
    counter = null;
    console.log(
        JSON.stringify({
            label,
            ms: +(performance.now() - start).toFixed(2),
            ...counts,
            luaCalls,
            regexCalls,
            hostCalls,
            ...value,
        }),
    );
}
async function pass() {
    let hits = 0,
        failed = 0;
    for (let i = 0; i < 500; i += 64) {
        const r = await service.transform(
            request(Array.from({ length: Math.min(64, 500 - i) }, (_, j) => target(i + j))),
            signal,
        );
        hits += r.results.filter((r) => r.cached).length;
        failed += r.results.filter((r) => !r.ok).length;
    }
    return { hits, failed };
}
try {
    console.log(JSON.stringify({ node: process.version, scopeKinds: jobScopeKinds(kinds).map((k) => k.name) }));
    await measure("cold-500-plain-8-batches", pass);
    await measure("hit-500-plain-8-batches", pass);
    patchChat([{ op: "meta", merge: { scriptstate: { $v: "1" } } }]);
    await measure("after-variable-500-8-batches", pass);
    patchChar({ lastInteraction: Date.now() });
    await measure("after-stamp-500-8-batches", pass);
    await measure("one-loadJobScope", async () => {
        loadJobScope(store, kinds, context);
        return {};
    });
    await measure("500-whole-chat-hydrations-local-model", async () => {
        let bytes = 0;
        for (let i = 0; i < 500; i++) {
            const chat = store.readChatSource("c", "k");
            chatBaseline(chat.revision, chat.data);
            bytes += Buffer.byteLength(
                JSON.stringify({
                    type: "chat",
                    characterId: "c",
                    chatId: "k",
                    revision: chat.revision,
                    data: chat.data,
                }),
            );
        }
        return { bytes };
    });
    await measure("worker-warmup", async () => {
        await workers.warm();
        return {};
    });
    patchChar({
        customscript: Array.from({ length: 10 }, (_, i) => ({
            comment: "",
            in: `never_match_${i}`,
            out: "z",
            type: "editdisplay",
            flag: "g",
        })),
    });
    await measure("500-targets-10-no-match-regex", pass);
    patchChar({
        customscript: [],
        triggerscript: [
            {
                comment: "lua",
                type: "start",
                conditions: [],
                effect: [
                    {
                        type: "triggerlua",
                        code: 'listenEdit("editDisplay", function(id,data,meta) return data .. "|stored=" .. getChatData(id,meta.index) end)',
                    },
                ],
            },
        ],
    });
    const changedRequest = request([target(0, "LOCAL_NEW")]);
    const first = (await service.transform(changedRequest, signal)).results[0];
    patchChat([{ op: "setText", id: "m0", text: "LOCAL_NEW" }]);
    const second = (await service.transform(changedRequest, signal)).results[0];
    const third = (await service.transform(request([{ ...target(0, "LOCAL_NEW"), noCache: true }]), signal)).results[0];
    console.log(
        JSON.stringify({
            label: "mixed-revision-cache",
            first: { cached: first.cached, text: first.text?.slice(0, 90) },
            afterSave: { cached: second.cached, text: second.text?.slice(0, 90) },
            bypass: { cached: third.cached, text: third.text },
            sameKey: first.key === second.key,
        }),
    );
    patchChar({
        customscript: [{ comment: "", in: "X", out: "{{screenwidth}}", type: "editdisplay", flag: "g" }],
        triggerscript: [],
    });
    const wide = (await service.transform(request([target(1, "X")]), signal)).results[0];
    const narrow = (
        await service.transform(
            request([target(1, "X")], {
                clientId: "phone",
                client: { viewport: { width: 320, height: 600 }, browserLanguage: "en" },
            }),
            signal,
        )
    ).results[0];
    console.log(
        JSON.stringify({
            label: "viewport-cross-client",
            wide: { text: wide.text, cached: wide.cached },
            narrow: { text: narrow.text, cached: narrow.cached },
        }),
    );
    patchChar({ customscript: [], triggerscript: [] });
    const scope = loadJobScope(store, kinds, context);
    const baseline = { chat: structuredClone(scopeChat(scope)), revision: scope.chatRevision };
    const result = structuredClone(baseline.chat);
    result.scriptstate = { ...result.scriptstate, $a: "1" };
    patchChat([{ op: "meta", merge: { scriptstate: { $a: "1" } } }]);
    patchChat([
        { op: "meta", merge: { scriptstate: { $b: "saved-by-another-tab" } } },
        { op: "setText", id: "m1", text: "EDITED_OLDER_MESSAGE" },
    ]);
    const token = "probe-job";
    lock.addToken(token);
    const job = {
        id: "probe-job",
        kind: "command",
        context,
        command: null,
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted" }),
            callback: async () => ({ outcome: "refused" }),
        },
        ownerAttached: () => true,
        epoch: store.epoch(),
        signal,
        emit() {},
        emitRecords() {
            return [];
        },
        write: (build) => store.applyChanges(build(), { epoch: store.epoch(), jobToken: token }),
        onClientMessage: () => () => {},
    };
    const before = store.readChatSource("c", "k").data.scriptstate;
    applyTriggerChat({ job, store, scope, lock }, baseline, result);
    const after = store.readChatSource("c", "k").data;
    console.log(
        JSON.stringify({
            label: "trigger-disjoint-variable-loss",
            before,
            after: after.scriptstate,
            olderMessage: after.message[1].data,
        }),
    );
    await service.close();
    service = createTransformService(deps);
    patchChat([{ op: "replace", chat: makeChat(500, 32768) }]);
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    let pending = [];
    for (let i = 0; i < 4; i++)
        pending.push(await service.transform(request([target(0, "tiny")], { handlers: "probe-handler" }), signal));
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    console.log(
        JSON.stringify({
            label: "four-tiny-snapshots",
            stats: service.stats(),
            pendingTextBytes: pending.reduce((n, r) => n + Buffer.byteLength(r.pending[0].text), 0),
            heapDeltaMiB: +((heapAfter - heapBefore) / 1048576).toFixed(2),
            chatTextMiB: (500 * 32768) / 1048576,
        }),
    );
} finally {
    await service.close();
    await workers.dispose();
    store.close();
    scratchDb.close();
}
