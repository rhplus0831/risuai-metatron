import { reconcileSelection, settings } from "./storage/settingsViews.svelte";
import { sleep } from "./util";
import { get } from "svelte/store";
import { COLLECTION_KIND, COLLECTION_SELECTION_FIELDS, SECTION_FIELDS, SECTION_KIND } from "../../shared/sections.ts";
import { mirrorFields, setMaskedSecrets } from "./storage/llmSecrets.svelte";
import type { MaskedLlmSecrets } from "../../shared/llmSecrets.ts";
import { loadSelection } from "./storage/selection.svelte";
import { startRouter } from "./router/router.svelte";
import { botMakerMode, loadedStore, LoadingStatusState } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, waitAlert, alertConfirm, alertInput } from "./alert";
import { characterURLImport } from "./characterCards";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { changeLanguage, language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { moduleUpdate } from "./process/modules";
import { setUsingSw } from "./globalApi.svelte";
import { RESOURCE_KIND, type ResourceReadKindsResult, SINGLETON_RESOURCE_ID } from "../../shared/resources.ts";
import { readBoot, readKinds } from "./storage/resourceClient";
import { indexedDbBootCacheStore, loadBootSnapshot, scheduleBootCacheCommit } from "./storage/bootCache";
import { appVer } from "./storage/database.svelte";
import {
    heldRecordRevision,
    onRemoteRecordApplied,
    seedResources,
    setRemoteResourceOwner,
    startResourceSync,
} from "./storage/resourceSync.svelte";
import { characterList, removeCharacters } from "./storage/characterStore.svelte";
import { checkCharOrderAtBoot, queueRemoteCharOrderRepair } from "./storage/characterOrder";
import { importBrowserLocalData } from "./storage/browserLocalImport";
import { assembleChats, initializeChats, seedChats, setRemoteChatListener } from "./storage/chatStore.svelte";
import { invalidateInlayCaches, noteRemoteInlay, reconcileInlays, seedInlays } from "./process/files/inlays";
import { loadPluginPermissions, refreshPluginPermissions } from "./plugins/apiV3/permissionStore";
import { startEventFeed } from "./network/eventFeed";
import { registerModelDynamic } from "./model/modellist";
import { initializeRecords, type RecordFields, type RecordKind } from "./storage/records.svelte";
import { flushClientDiagnostics, recordClientEvent } from "./diagnostics/collector";

/**
 * Loads the application data.
 */
export async function loadData() {
    const loaded = get(loadedStore);
    if (!loaded) {
        try {
            LoadingStatusState.text = "Loading Save Data...";
            // Chat summaries, not chats (Phase 6 slice 9b): no message row is read here; a chat is
            // loaded when it is selected or a consumer needs it. The read skips what the boot cache
            // holds (`bootCache.ts`), falling back to the plain read; the cache is written after the boot.
            const { snapshot, commit: commitBootCache } = await loadBootSnapshot({
                store: indexedDbBootCacheStore(appVer),
                appVer,
                readBoot,
                readKinds: () => readKinds(Object.values(RESOURCE_KIND), { chatSummaries: true }),
                report: recordClientEvent,
            });
            // What the server holds, recorded before normalization changes anything, so the first save
            // writes exactly what the client normalized.
            seedResources(snapshot);
            seedChats(snapshot.chatSummaries ?? snapshot.chats ?? [], snapshot.chatOrders ?? []);
            seedInlays(snapshot.kinds[RESOURCE_KIND.inlays] ?? []);
            // This client's preset and lorebook page; the installation checks the ids.
            loadSelection();
            installBootRecords(snapshot);
            applyFirstBootDefaults();

            LoadingStatusState.text = "Checking Service Worker...";
            if (navigator.serviceWorker) {
                const status = await registerSw();
                setUsingSw(status === "ready");
                if (status === "reloading") {
                    return;
                }
            } else {
                recordClientEvent({ kind: "serviceWorker", phase: "unsupported" });
                setUsingSw(false);
            }
            try {
                const isInStandaloneMode =
                    window.matchMedia("(display-mode: standalone)").matches ||
                    //@ts-expect-error navigator.standalone is iOS Safari non-standard property, not in Navigator interface
                    window.navigator.standalone ||
                    document.referrer.includes("android-app://");
                if (isInStandaloneMode) {
                    await navigator.storage.persist();
                }
            } catch (error) {}
            LoadingStatusState.text = "Checking For Format Update...";
            maintainCharacters();
            // Each tab selects its own chat (the browser's last choice), and a character without a
            // chat gets one; queued work waits until saving starts below.
            initializeChats();

            LoadingStatusState.text = "Updating States...";
            updateColorScheme();
            updateTextThemeAndCSS();
            updateAnimationSpeed();
            updateHeightMode();
            updateErrorHandling();
            updateGuisize();
            if (!localStorage.getItem("nightlyWarned") && import.meta.env.VITE_RISU_NIGHTLY_BUILD === "TRUE") {
                alertMd(language.nightlyWarning);
                await waitAlert();
                localStorage.setItem("nightlyWarned", "true");
            }

            // Saving starts before plugins load, so the browser-local import below can save.
            startResourceSync();
            watchRemoteRecords();
            // After saving starts: a link's or share's module import waits for its save's
            // acknowledgement (`addImportedModule`), which a flush before the start would skip.
            characterURLImport();
            LoadingStatusState.text = "Moving Browser Data To The Server...";
            await importBrowserLocalData();
            await loadPluginPermissions();
            // Live updates (Phase 6): other tabs' and devices' changes reach this tab from here on.
            setRemoteResourceOwner(RESOURCE_KIND.inlays, { apply: noteRemoteInlay, reconcile: reconcileInlays });
            setRemoteResourceOwner(RESOURCE_KIND.pluginPermissions, {
                apply: (_id, revision) => refreshPermissionsWithRetry(revision),
            });
            startEventFeed();
            LoadingStatusState.text = "Loading Plugins...";
            try {
                await loadPlugins();
            } catch (error) {}

            if (settings.ui.botSettingAtStart) {
                botMakerMode.set(true);
            }
            loadedStore.set(true);
            // The URL picks the screen (a reload keeps it); from here on the history follows the stores.
            startRouter();
            // What the boot read gave goes into the boot cache when the tab is idle.
            void scheduleBootCacheCommit(commitBootCache);
            // Web Push (`docs/plan/web-push.md`): this browser's subscription kept in line, and the
            // one-time banner offered. Nothing here asks for the permission.
            void import("./network/pushNotifications")
                .then(({ startPushNotifications }) => startPushNotifications())
                .catch((error) => console.error("[Push]", error));
            // Clear this tab's unseen and recovery marks when its open chat changes.
            void import("./process/chatStatus.svelte")
                .then(({ watchChatVisibility }) => watchChatVisibility())
                .catch((error) => console.error("[Generation]", error));
            // A server job of this tab that a reload interrupted (a Lua button, Phase 5 slice 8a)
            // is attached again; nothing is sent when the tab has none.
            void import("./process/serverCommands")
                .then(({ resumeServerJobs }) => resumeServerJobs())
                .catch((error) => console.error("[Generation]", error));
            startObserveDom();
            registerModelDynamic();
            moduleUpdate();
            cleanLegacyAccountData();
        } catch (error) {
            alertError(error);
        }
    }
}

/**
 * Installs the server resources into the records (`initializeRecords`, nothing queued): the five
 * sections (their `SECTION_FIELDS`), the collections (`translatorPresets` and `hypaV3Presets` as
 * `{ items, selectedId }`), `presets`, `modules` and `plugins` (`[]` when the server has none yet,
 * which the first save then creates), `pluginStorage` when present, and the characters in creation
 * order, without chats: the chat module holds every chat in its server order (`assembleChats`; the
 * boot read gives summaries, held as unloaded chats). The server creates and normalizes every
 * section, collection, and the presets, so a missing one is an error, not a default. The
 * `llmSecrets` record is masked (Phase 5 slice 7b): its status goes to `llmSecretState`, and the
 * record's credential fields are `""`. Then this client's selection is resolved against the records
 * and the interface language is set.
 */
export function installBootRecords(snapshot: ResourceReadKindsResult) {
    const single = (kind: string) =>
        snapshot.kinds[kind]?.find((record) => record.id === SINGLETON_RESOURCE_ID)?.data as any;
    const required = (kind: string) => {
        const data = single(kind);
        if (data === undefined) {
            throw new Error(`The server returned no ${kind} record`);
        }
        return data;
    };
    const fields: RecordFields = {};
    for (const section of Object.values(SECTION_KIND)) {
        // The write-only `llmSecrets` record arrives masked: its siblings into the record (the
        // credential fields `""`), its status into `llmSecretState`.
        const record = section === SECTION_KIND.llmSecrets ? mirrorFields(required(section)) : required(section);
        const data: Record<string, unknown> = {};
        let any = false;
        for (const field of SECTION_FIELDS[section]) {
            if (Object.hasOwn(record, field)) {
                any = true;
                if (record[field] !== undefined) {
                    data[field] = record[field];
                }
            }
        }
        if (any) {
            fields[section] = data;
        }
    }
    setMaskedSecrets(required(RESOURCE_KIND.llmSecrets) as MaskedLlmSecrets);
    for (const kind of Object.values(COLLECTION_KIND)) {
        const record = required(kind);
        fields[kind as RecordKind] = Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind)
            ? { items: record.items ?? [], selectedId: record.selectedId ?? null }
            : record;
    }
    fields.presets = required(RESOURCE_KIND.presets);
    fields.modules = single(RESOURCE_KIND.modules) ?? [];
    fields.plugins = single(RESOURCE_KIND.plugins) ?? [];
    const pluginStorage = single(RESOURCE_KIND.pluginStorage);
    if (pluginStorage !== undefined) {
        fields.pluginStorage = pluginStorage;
    }
    const characters = (snapshot.kinds[RESOURCE_KIND.characters] ?? []).map((record) => record.data as any);
    fields.characters = characters;
    assembleChats(characters, snapshot.chatSummaries ?? snapshot.chats ?? [], snapshot.chatOrders ?? []);
    initializeRecords(fields);
    reconcileSelection();
    changeLanguage(settings.ui.language);
}

const BROWSER_UI_LANGUAGES = ["de", "en", "ko", "cn", "vi", "zh-Hant"];

/**
 * The first boot of a store (`didFirstSetup` unset): the UI language follows the browser's when it is
 * one the UI has, as the removed first-run wizard's language step did. Every other setting keeps the
 * server's default; the settings pages change them.
 */
function applyFirstBootDefaults() {
    if (settings.ui.didFirstSetup) {
        return;
    }
    const browserLang = navigator.language?.split("-")[0];
    if (browserLang && BROWSER_UI_LANGUAGES.includes(browserLang)) {
        settings.ui.language = browserLang;
        changeLanguage(browserLang);
    }
    settings.ui.didFirstSetup = true;
}

/** A live update of the plugin permissions: read again, retried a few times (5 s apart) after a failed read. */
function refreshPermissionsWithRetry(revision: string | null, attempt = 0) {
    refreshPluginPermissions(revision).catch((error) => {
        console.error("[Live updates]", error);
        if (attempt < 3) {
            setTimeout(() => refreshPermissionsWithRetry(revision, attempt + 1), 5000);
        }
    });
}

/**
 * Records another tab wrote may reference inlays this tab has not seen: a remote reload drops the
 * inlay caches. A remote `characterOrder` may lack a character this tab created: it is appended
 * (`queueRemoteCharOrderRepair`). Exported for tests.
 */
export function watchRemoteRecords() {
    onRemoteRecordApplied((kind) => {
        invalidateInlayCaches();
        if (kind === RESOURCE_KIND.characterOrder) {
            queueRemoteCharOrderRepair((chaId) => heldRecordRevision(RESOURCE_KIND.characters, chaId));
        }
    });
    setRemoteChatListener(() => invalidateInlayCaches());
}

const SW_INIT_RELOAD_KEY = "risu.serviceWorker.initReload";

/** Registers the worker, allowing at most one reload until initialization succeeds. */
async function registerSw(): Promise<"ready" | "unavailable" | "reloading"> {
    try {
        await navigator.serviceWorker.register("/sw.js", {
            scope: "/",
        });
    } catch {
        recordClientEvent({ kind: "serviceWorker", phase: "registerFailed" });
        return "unavailable";
    }
    recordClientEvent({ kind: "serviceWorker", phase: "registered" });
    await sleep(100);
    let da: Response;
    try {
        da = await fetch("/sw/init");
    } catch {
        recordClientEvent({ kind: "serviceWorker", phase: "initFailed" });
        return "unavailable";
    }
    if (!(da.status >= 200 && da.status < 300)) {
        recordClientEvent({ kind: "serviceWorker", phase: "initFailed" });
        try {
            if (sessionStorage.getItem(SW_INIT_RELOAD_KEY) !== null) {
                return "unavailable";
            }
            sessionStorage.setItem(SW_INIT_RELOAD_KEY, "1");
        } catch {
            return "unavailable";
        }
        recordClientEvent({ kind: "sync", phase: "reload", reason: "serviceWorker" });
        flushClientDiagnostics();
        location.reload();
        return "reloading";
    }
    try {
        sessionStorage.removeItem(SW_INIT_RELOAD_KEY);
    } catch {}
    return "ready";
}

/**
 * Updates the error handling by adding custom handlers for errors and unhandled promise rejections.
 */
function updateErrorHandling() {
    const errorHandler = (event: ErrorEvent) => {
        console.error(event.error);
        if (!(event.error.target instanceof Worker)) {
            alertError(event.error);
        }
    };
    const rejectHandler = (event: PromiseRejectionEvent) => {
        console.error(event.reason);
        alertError(event.reason);
    };
    window.addEventListener("error", errorHandler);
    window.addEventListener("unhandledrejection", rejectHandler);
}

/**
 * Updates the height mode of the document based on the value stored in the database.
 */
function updateHeightMode() {
    const root = document.querySelector(":root") as HTMLElement;
    switch (settings.ui.heightMode) {
        case "auto":
            root.style.setProperty("--risu-height-size", "100%");
            break;
        case "vh":
            root.style.setProperty("--risu-height-size", "100vh");
            break;
        case "dvh":
            root.style.setProperty("--risu-height-size", "100dvh");
            break;
        case "lvh":
            root.style.setProperty("--risu-height-size", "100lvh");
            break;
        case "svh":
            root.style.setProperty("--risu-height-size", "100svh");
            break;
        case "percent":
            root.style.setProperty("--risu-height-size", "100%");
            break;
    }
}

/**
 * The boot's maintenance of the installed characters: those in the trash for more than three days
 * are deleted (one change of the list), and the character order is repaired against the complete
 * inventory, dropping dangling ids before saving and the event feed start. The characters arrive
 * normalized by the server (`normalizeCharacter`); the client applies no default at boot (Phase 6
 * slice 5b).
 */
function maintainCharacters() {
    const now = Date.now();
    removeCharacters(
        characterList()
            .filter((v) => v.trashTime && v.trashTime + 1000 * 60 * 60 * 24 * 3 < now)
            .map((v) => v.chaId),
    );
    checkCharOrderAtBoot();
}

/**
 * Removes localStorage flags left behind by the removed Risu Account sync, ToS popup and nightly hub switch.
 * The `risuaiAccountCached` IndexedDB is kept on purpose: it may hold a former sync user's latest database copy.
 */
function cleanLegacyAccountData() {
    for (const key of ["accountst", "dosync", "fallbackRisuToken", "tos2", "tos4", "hub"]) {
        try {
            localStorage.removeItem(key);
        } catch (error) {}
    }
}
