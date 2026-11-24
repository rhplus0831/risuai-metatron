import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { CHARX_IMPORT_PATH } from "../../../../shared/charxImport.ts";
import { MODULE_IMPORT_PATH } from "../../../../shared/moduleImport.ts";
import { REALM_CANCEL_PATH, REALM_COMMIT_PATH, REALM_IMPORT_PATH } from "../../../../shared/realmImport.ts";
import { UPSTREAM_IMPORT_COMMIT_PATH, UPSTREAM_IMPORT_PREPARE_PATH } from "../../../../shared/upstreamBackup.ts";
import { NEXT_DIALOG_GAP_MS } from "../../alertQueue";
import { deferred } from "../../checkpoints/tests/checkpointServer";
import { REALM_TERMS_VERSION } from "../../realmTerms";
import { cardV3, charx } from "./importFixtures";
import { bootMutations, warmMutationGraph } from "./mutationStoresHarness";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("../serverAuth").authFetch>() }));
vi.mock("../serverAuth", async () => (await import("./serverAuthMock")).createServerAuthMock({ authFetch }));

const moduleRecord = { name: "Packed module", description: "", id: "module-file", assets: [] };
const card = cardV3("Imported card");
const charxResult = { card: JSON.stringify(card), moduleData: null, assets: {}, excluded: [] };
const committed = { kind: "charx", assets: {}, excluded: [] };
const staged = { kind: "charx", token: "staged-card", card: charxResult.card, moduleData: null };
const selection = { promptPresetId: "prompt", modelPresetId: "model", personaId: "persona" };
const prepared = { token: "backup", selection, report: { counts: {}, converted: [], excluded: [], missingAssets: [] } };
const line = (value: unknown) => JSON.stringify(value) + "\n";
const turn = () => vi.advanceTimersByTimeAsync(0);
const cancelled = "The import was cancelled. Nothing was added.";

let tab: Awaited<ReturnType<typeof bootMutations>>;
let alerts: typeof import("../../alert");

let moduleFile: File;
let cards: typeof import("../../characterCards");
let modules: typeof import("../../process/modules");
let backup: typeof import("../../drive/upstreamBackupClient");

beforeAll(async () => {
    await warmMutationGraph(() => import("../../characterCards"));
    const modules = await import("../../process/modules");
    const packed = await modules.exportModuleLegacy(moduleRecord, { saveData: false, alertEnd: false });
    moduleFile = new File([new Uint8Array(packed!)], "module.risum");
});

beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(location, "reload").mockImplementation(() => {});
    tab = await bootMutations((server) =>
        authFetch.mockImplementation((url, init, options) => {
            options?.beforeDispatch?.();
            return server.fetch(url, init);
        }),
    );
    tab.settings.ui.realmTermsAccepted = REALM_TERMS_VERSION;
    tab.settings.ui.goCharacterOnImport = false;
    await tab.sync.flushResources();
    alerts = await import("../../alert");
    cards = await import("../../characterCards");
    modules = await import("../../process/modules");
    backup = await import("../../drive/upstreamBackupClient");
});

afterEach(() => {
    tab.sync.stopResourceSync();
    tab.fake.close();
    vi.clearAllTimers();
    authFetch.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const uploadCharx = () => {
    const file = new File([new Uint8Array(charx(card))], "card.charx");
    return cards.importCharacterProcess({ name: file.name, data: file });
};
const download = () => cards.downloadRisuHub("card-id");
const restore = () => backup.restoreUpstreamBackup(new File(["backup"], "backup.bin"));

const imports = [
    {
        name: "module upload",
        path: MODULE_IMPORT_PATH,
        run: () => modules.importModuleFile(moduleFile),
        result: { module: moduleRecord, assetsWritten: 0, assetsSkipped: 0 },
    },
    { name: "CharX upload", path: CHARX_IMPORT_PATH, run: uploadCharx, result: charxResult },
    { name: "Realm prepare", path: REALM_IMPORT_PATH, run: download, result: staged },
    { name: "Realm commit", path: REALM_COMMIT_PATH, run: download, result: committed },
    { name: "backup prepare", path: UPSTREAM_IMPORT_PREPARE_PATH, run: restore, result: prepared },
];

function answerRequest(path: string, response: Promise<Response> | Response) {
    authFetch.mockImplementation(async (url, init, options) => {
        options?.beforeDispatch?.();
        if (url === path) return response;
        if (url === REALM_IMPORT_PATH) return new Response(line(staged));
        if (url === REALM_CANCEL_PATH) return new Response(null, { status: 204 });
        if (url === UPSTREAM_IMPORT_PREPARE_PATH) return new Response(line(prepared));
        if (url === REALM_COMMIT_PATH) return new Response(line(committed));
        return tab.fake.fetch(url, init);
    });
}

const requests = (path: string) => authFetch.mock.calls.filter(([url]) => url === path);
// A late chunk or EOF can still reach a reader that a cancelled import left running.
function heldBody(status = 200) {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            stream = controller;
        },
        cancel() {
            stream = undefined;
        },
    });
    return {
        response: new Response(body, { status }),
        write(text: string) {
            stream?.enqueue(new TextEncoder().encode(text));
        },
        end() {
            stream?.close();
        },
    };
}

function currentWait() {
    const wait = get(tab.stores.alertStore);
    expect(wait).toMatchObject({ type: "wait", onCancel: expect.any(Function) });
    return wait;
}

function expectStageCancelledOnce() {
    expect(requests(REALM_CANCEL_PATH).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { token: staged.token },
    ]);
}

describe.each(imports)("$name", ({ path, run, result }) => {
    it("hands off after ten silent minutes with Cancel cleared", async () => {
        const headers = deferred<Response>();
        answerRequest(path, headers.promise);
        const action = run();
        await turn();
        expect(requests(path)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(600_000);
        currentWait();

        // The local permission dialog lets us inspect the wait as soon as Realm prepare hands off.
        const answer =
            path === REALM_IMPORT_PATH
                ? { ...staged, card: JSON.stringify(cardV3("Imported card", {}, { lowLevelAccess: true })) }
                : result;
        // Hold the first local save so a later success dialog cannot hide a lingering Cancel.
        const savesCharacter = path === CHARX_IMPORT_PATH || path === REALM_COMMIT_PATH;
        tab.fake.holdNextBatch = savesCharacter;
        headers.resolve(new Response(line(answer)));
        await turn();
        try {
            if (savesCharacter) expect(tab.fake.releaseBatch).toBeTypeOf("function");
            expect(tab.stores.alertStore.status()?.onCancel).toBeUndefined();
        } finally {
            tab.fake.releaseBatch?.();
        }
        if (path === REALM_IMPORT_PATH) {
            expect(get(tab.stores.alertStore).type).toBe("select");
            tab.stores.alertStore.answer("0");
        }
        if (path === UPSTREAM_IMPORT_PREPARE_PATH) {
            expect(get(tab.stores.alertStore).type).toBe("upstreamImportReport");
            tab.stores.alertStore.answer("");
        }
        const imported = await action;
        if (path === MODULE_IMPORT_PATH) expect(imported).toMatchObject({ name: moduleRecord.name });
        if (savesCharacter || path === REALM_IMPORT_PATH) {
            expect(tab.characterList().at(-1)?.name).toBe(card.data.name);
        }
    });

    it.each(["headers", "body"] as const)("cancels while waiting for %s and adds nothing", async (phase) => {
        const headers = deferred<Response>();
        answerRequest(path, headers.promise);
        const settled = vi.fn();
        const before = tab.characterList().map((c) => c.chaId);
        const action = run().then(settled);
        await turn();
        expect(requests(path)).toHaveLength(1);
        let wait = currentWait();

        const body = heldBody();
        if (phase === "body") {
            headers.resolve(body.response);
            // Realm prepare sends only its result. The other requests replace the wait with progress.
            if (path !== REALM_IMPORT_PATH) {
                for (const done of [1, 2]) {
                    const counts = { done, total: 2 };
                    body.write(line(path === UPSTREAM_IMPORT_PREPARE_PATH ? { phase: "assets", ...counts } : counts));
                    await turn();
                    const progress = currentWait();
                    expect(progress.msg).not.toBe(wait.msg);
                    wait = progress;
                }
            }
            body.write(line(result));
            await turn(); // The result is available, but the answer still has no EOF.
            wait = currentWait();
        }

        wait.onCancel!();
        await turn();
        expect(requests(path)[0][1]?.signal?.aborted).toBe(true);
        expect(settled).toHaveBeenCalledOnce();
        await action;
        if (phase === "headers") {
            headers.resolve(body.response);
            body.write(line(result));
        }
        body.end();
        await turn();
        expect(get(tab.stores.alertStore)).toMatchObject({ type: "error", msg: cancelled });
        if (path === MODULE_IMPORT_PATH || path === CHARX_IMPORT_PATH) expect(settled).toHaveBeenCalledWith(null);
        expect(tab.settings.modules).toEqual([]);
        expect(tab.characterList().map((c) => c.chaId)).toEqual(before);
        if (path === UPSTREAM_IMPORT_PREPARE_PATH) {
            expect(get(alerts.upstreamImportReportStore)).toBeNull();
            expect(requests(UPSTREAM_IMPORT_COMMIT_PATH)).toHaveLength(0);
            expect(location.reload).not.toHaveBeenCalled();
        }
        if (path === REALM_COMMIT_PATH) expectStageCancelledOnce();
        if (path === REALM_IMPORT_PATH) expect(requests(REALM_COMMIT_PATH)).toHaveLength(0);
    });
});

it("cancels the Realm retry wait and releases the stage before the retry is due", async () => {
    answerRequest(REALM_COMMIT_PATH, Response.json({ error: "Another import is running" }, { status: 409 }));
    const settled = vi.fn();
    const before = tab.characterList().map((c) => c.chaId);
    const action = download().then(settled);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(requests(REALM_COMMIT_PATH)).toHaveLength(1);
    expect(requests(REALM_CANCEL_PATH)).toHaveLength(0);

    currentWait().onCancel!();
    await turn();
    expect(settled).toHaveBeenCalledOnce();
    expect(get(tab.stores.alertStore)).toMatchObject({ type: "error", msg: cancelled });
    expectStageCancelledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await action;
    expect(requests(REALM_COMMIT_PATH)).toHaveLength(1);
    expectStageCancelledOnce();
    expect(tab.characterList().map((c) => c.chaId)).toEqual(before);
});

it("cancels a backup prepare during its 412 body without reloading or opening a report", async () => {
    const body = heldBody(412);
    body.write('{"error":');
    answerRequest(UPSTREAM_IMPORT_PREPARE_PATH, body.response);
    const settled = vi.fn();
    const action = restore().then(settled);
    await turn();
    currentWait().onCancel!();
    await turn();
    expect(location.reload).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledOnce();
    await action;
    body.write('"EpochMismatch"}');
    body.end();
    await turn();
    expect(location.reload).not.toHaveBeenCalled();
    expect(get(tab.stores.alertStore)).toMatchObject({ type: "error", msg: cancelled });
    expect(get(alerts.upstreamImportReportStore)).toBeNull();
    expect(requests(UPSTREAM_IMPORT_COMMIT_PATH)).toHaveLength(0);
});

it("removes Cancel when backup prepare opens its report and keeps the restoring wait plain", async () => {
    const commit = deferred<Response>();
    answerRequest(UPSTREAM_IMPORT_COMMIT_PATH, commit.promise);
    const action = restore();
    await turn();
    expect(get(tab.stores.alertStore).type).toBe("upstreamImportReport");
    expect(tab.stores.alertStore.status()?.onCancel).toBeUndefined();
    get(alerts.upstreamImportReportStore)!.answer(true);
    tab.stores.alertStore.answer("yes");
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    expect(requests(UPSTREAM_IMPORT_COMMIT_PATH)).toHaveLength(1);
    const wait = get(tab.stores.alertStore);
    expect(wait).toMatchObject({ type: "wait", msg: language.upstreamImport.restoring });
    expect(wait.onCancel).toBeUndefined();
    commit.resolve(Response.json({ epoch: "restored", assetsWritten: 0, assetsSkipped: 0, selection }));
    await action;
    expect(location.reload).toHaveBeenCalledOnce();
});
