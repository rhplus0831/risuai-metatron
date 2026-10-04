import { sleep } from "./util";
import { v4 as uuidv4 } from "uuid";
import { get } from "svelte/store";
import { setDatabase, getDatabase, type Database } from "./storage/database.svelte";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    SECTION_FIELDS,
    SECTION_KIND,
} from "../../shared/sections.ts";
import { mirrorFields, setMaskedSecrets } from "./storage/llmSecrets.svelte";
import type { MaskedLlmSecrets } from "../../shared/llmSecrets.ts";
import { loadSelection } from "./storage/selection.svelte";
import { botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, waitAlert, alertConfirm, alertInput } from "./alert";
import { characterURLImport } from "./characterCards";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { moduleUpdate } from "./process/modules";
import { forageStorage, saveDb, setUsingSw, checkCharOrder } from "./globalApi.svelte";
import { RESOURCE_KIND, type ResourceReadKindsResult, SINGLETON_RESOURCE_ID } from "../../shared/resources.ts";
import { readKinds } from "./storage/resourceClient";
import {
    markCharactersDirty,
    onRemoteRecordApplied,
    releaseDeferredCharacters,
    seedResources,
    setGeneratingCharacter,
    setRemoteResourceOwner,
} from "./storage/resourceSync.svelte";
import { importBrowserLocalData } from "./storage/browserLocalImport";
import { assembleChats, initializeChats, seedChats, setRemoteChatListener } from "./storage/chatStore.svelte";
import { invalidateInlayCaches, noteRemoteInlay, reconcileInlays, seedInlays } from "./process/files/inlays";
import { loadPluginPermissions, refreshPluginPermissions } from "./plugins/apiV3/permissionStore";
import { startEventFeed } from "./network/eventFeed";
import { doingChat } from "./process/index.svelte";
import { registerModelDynamic } from "./model/modellist";

/**
 * Loads the application data.
 */
export async function loadData() {
    const loaded = get(loadedStore);
    if (!loaded) {
        try {
            await forageStorage.Init();

            LoadingStatusState.text = "Loading Save Data...";
            const snapshot = await readKinds(Object.values(RESOURCE_KIND), { chats: true });
            // What the server holds, recorded before normalization changes anything, so the first save
            // writes exactly what the client normalized.
            seedResources(snapshot);
            seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
            seedInlays(snapshot.kinds[RESOURCE_KIND.inlays] ?? []);
            // This client's preset and lorebook page; the forwarding layer checks the ids.
            loadSelection();
            setDatabase(assembleDatabase(snapshot));

            LoadingStatusState.text = "Checking Service Worker...";
            if (navigator.serviceWorker) {
                setUsingSw(true);
                await registerSw();
            } else {
                setUsingSw(false);
            }
            if (getDatabase().didFirstSetup) {
                characterURLImport();
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
            await checkNewFormat();
            assignIds();
            // Each tab selects its own chat (the browser's last choice), and a character without a
            // chat gets one; queued work waits until saving starts below.
            initializeChats();
            const db = getDatabase();

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
            saveDb();
            watchGeneration();
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

            if (db.botSettingAtStart) {
                botMakerMode.set(true);
            }
            loadedStore.set(true);
            selectedCharID.set(-1);
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
 * Builds the in-memory `Database` from the server resources: the five sections (their
 * `SECTION_FIELDS`), the collections (`translatorPresets` and `hypaV3Presets` unpack
 * `{ items, selectedId }` into their two fields), the Phase 1 collections, and the characters in
 * creation order, each with its chats in their server order. The flat preset and persona fields
 * and the selection indexes are not assembled: the forwarding layer serves them
 * (`forwarding.svelte.ts`). The server creates and normalizes
 * every section and collection, so a missing one is an error, not a default. The `llmSecrets`
 * record is masked (Phase 5 slice 7b): its status goes to `llmSecretState`, and the mirror's
 * credential fields are `""`.
 */
export function assembleDatabase(snapshot: ResourceReadKindsResult): Database {
    const single = (kind: string) =>
        snapshot.kinds[kind]?.find((record) => record.id === SINGLETON_RESOURCE_ID)?.data as any;
    const required = (kind: string) => {
        const data = single(kind);
        if (data === undefined) {
            throw new Error(`The server returned no ${kind} record`);
        }
        return data;
    };
    const db: Record<string, unknown> = {};
    for (const section of Object.values(SECTION_KIND)) {
        // The write-only `llmSecrets` record arrives masked: its siblings into the mirror (the
        // credential fields `""`), its status into `llmSecretState`.
        const record = section === SECTION_KIND.llmSecrets ? mirrorFields(required(section)) : required(section);
        for (const field of SECTION_FIELDS[section]) {
            if (Object.hasOwn(record, field)) {
                db[field] = record[field];
            }
        }
    }
    setMaskedSecrets(required(RESOURCE_KIND.llmSecrets) as MaskedLlmSecrets);
    for (const kind of Object.values(COLLECTION_KIND)) {
        const record = required(kind);
        if (Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind)) {
            db[COLLECTION_FIELDS[kind]] = record.items;
            db[COLLECTION_SELECTION_FIELDS[kind as keyof typeof COLLECTION_SELECTION_FIELDS]] = record.selectedId;
        } else {
            db[COLLECTION_FIELDS[kind]] = record;
        }
    }
    db.botPresets = required(RESOURCE_KIND.presets);
    const modules = single(RESOURCE_KIND.modules);
    if (modules !== undefined) {
        db.modules = modules;
    }
    const plugins = single(RESOURCE_KIND.plugins);
    if (plugins !== undefined) {
        db.plugins = plugins;
    }
    const pluginStorage = single(RESOURCE_KIND.pluginStorage);
    if (pluginStorage !== undefined) {
        db.pluginCustomStorage = pluginStorage;
    }
    const characters = (snapshot.kinds[RESOURCE_KIND.characters] ?? []).map((record) => record.data as any);
    db.characters = characters;
    assembleChats(characters, snapshot.chats ?? [], snapshot.chatOrders ?? []);
    return db as unknown as Database;
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
 * While a generation runs, a conflict does not swap its character out; when it ends, the character it
 * wrote is saved (it may no longer be selected) and any deferred reload runs. Records another tab
 * wrote may reference inlays this tab has not seen, so a remote reload drops the inlay caches.
 */
function watchGeneration() {
    let generatingId: string | null = null;
    setGeneratingCharacter(() => generatingId);
    onRemoteRecordApplied(() => invalidateInlayCaches());
    setRemoteChatListener(() => invalidateInlayCaches());
    doingChat.subscribe((running) => {
        if (running) {
            generatingId = DBState.db.characters?.[get(selectedCharID)]?.chaId ?? null;
            return;
        }
        if (generatingId) {
            markCharactersDirty([generatingId]);
            generatingId = null;
        }
        releaseDeferredCharacters();
    });
}

/**
 * Registers the service worker and initializes it.
 */
async function registerSw() {
    await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
    });
    await sleep(100);
    const da = await fetch("/sw/init");
    if (!(da.status >= 200 && da.status < 300)) {
        location.reload();
    }
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
    const db = getDatabase();
    const root = document.querySelector(":root") as HTMLElement;
    switch (db.heightMode) {
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
 * Checks and updates the database format to the latest version.
 */
async function checkNewFormat(): Promise<void> {
    let db = getDatabase();

    // Check data integrity
    db.characters = db.characters
        .map((v) => {
            if (!v) {
                return null;
            }
            v.chaId ??= uuidv4();
            v.type ??= "character";
            v.customscript ??= [];
            v.firstMessage ??= "";
            v.globalLore ??= [];
            v.name ??= "";
            v.viewScreen ??= "none";
            v.emotionImages = v.emotionImages ?? [];

            if (v.type === "character") {
                v.bias ??= [];
                v.characterVersion ??= "";
                v.creator ??= "";
                v.desc ??= "";
                v.utilityBot ??= false;
                v.tags ??= [];
                v.systemPrompt ??= "";
                v.scenario ??= "";
            }
            return v;
        })
        .filter((v) => {
            return v !== null;
        });

    for (let i = 0; i < db.characters.length; i++) {
        const trashTime = db.characters[i].trashTime;
        const targetTrashTime = trashTime ? trashTime + 1000 * 60 * 60 * 24 * 3 : 0;
        if (trashTime && targetTrashTime < Date.now()) {
            db.characters.splice(i, 1);
            i--;
        }
    }
    setDatabase(db);
    checkCharOrder();
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

/**
 * Assigns unique character ids. Chat and message ids come from the server (and the chat module for
 * new ones).
 */
function assignIds() {
    if (!DBState?.db?.characters) {
        return;
    }
    const assignedIds = new Set<string>();
    for (let i = 0; i < DBState.db.characters.length; i++) {
        const cha = DBState.db.characters[i];
        if (!cha.chaId) {
            cha.chaId = uuidv4();
        }
        if (assignedIds.has(cha.chaId)) {
            console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
            cha.chaId = uuidv4();
        }
        assignedIds.add(cha.chaId);
    }
}
