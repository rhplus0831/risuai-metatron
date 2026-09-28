import { checkNullish, sleep } from "./util";
import { v4 as uuidv4 } from "uuid";
import { get } from "svelte/store";
import { setDatabase, defaultSdDataFunc, getDatabase, presetTemplate, type Database } from "./storage/database.svelte";
import { botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, waitAlert, alertConfirm, alertInput } from "./alert";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { updateLorebooks } from "./characters";
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
} from "./storage/resourceSync.svelte";
import { importBrowserLocalData } from "./storage/browserLocalImport";
import { invalidateInlayCaches, seedInlays } from "./process/files/inlays";
import { loadPluginPermissions } from "./plugins/apiV3/permissionStore";
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
            const snapshot = await readKinds(Object.values(RESOURCE_KIND));
            // What the server holds, recorded before normalization changes anything, so the first save
            // writes exactly what the client normalized.
            seedResources(snapshot);
            seedInlays(snapshot.kinds[RESOURCE_KIND.inlays] ?? []);
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
            LoadingStatusState.text = "Loading Plugins...";
            try {
                await loadPlugins();
            } catch (error) {}

            if (db.botSettingAtStart) {
                botMakerMode.set(true);
            }
            loadedStore.set(true);
            selectedCharID.set(-1);
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
 * Builds the in-memory `Database` from the server resources: `root` holds every field except the
 * collections that have a resource of their own; characters come in creation order. Missing records
 * are left for `setDatabase` to default.
 */
function assembleDatabase(snapshot: ResourceReadKindsResult): Database {
    const single = (kind: string) =>
        snapshot.kinds[kind]?.find((record) => record.id === SINGLETON_RESOURCE_ID)?.data as any;
    const db = { ...(single(RESOURCE_KIND.root) ?? {}) } as Database;
    const presets = single(RESOURCE_KIND.presets);
    if (presets !== undefined) {
        db.botPresets = presets;
    }
    if (!Array.isArray(db.botPresets) || db.botPresets.length === 0) {
        db.botPresets = [safeStructuredClone(presetTemplate)];
        db.botPresetsId = 0;
    }
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
    db.characters = (snapshot.kinds[RESOURCE_KIND.characters] ?? []).map((record) => record.data as any);
    return db;
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
            v.chatPage ??= 0;
            v.chats ??= [];
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

    db.modules = await Promise.all(
        (db.modules ?? []).map(async (v) => {
            if (v?.lorebook) {
                if (!Array.isArray(v.lorebook)) {
                    console.error("Critical: Invalid lorebook format detected in module");
                    console.error("Module data:", JSON.stringify(v, null, 2));

                    // Alert user about corrupted data
                    alertError(language.bootstrap.dataCorruptionDetected(v.name || "Unknown", typeof v.lorebook));
                    await waitAlert();

                    // Ask if user wants to report the issue
                    const shouldReport = await alertConfirm(language.bootstrap.reportErrorQuestion);

                    if (shouldReport) {
                        try {
                            // Collect diagnostic information (without personal data)
                            const diagnosticInfo = {
                                timestamp: new Date().toISOString(),
                                moduleName: v.name || "Unknown",
                                lorebookType: typeof v.lorebook,
                                lorebookValue: JSON.stringify(v.lorebook).substring(0, 500), // First 500 chars only
                                isArray: Array.isArray(v.lorebook),
                                keys: v.lorebook ? Object.keys(v.lorebook).join(", ") : "N/A",
                                formatVersion: db.formatversion || "Unknown",
                            };

                            // Show the diagnostic info and allow user to copy or send
                            const reportData = JSON.stringify(diagnosticInfo, null, 2);
                            await alertMd(language.bootstrap.diagnosticInformation(reportData));
                            await waitAlert();

                            console.log("Diagnostic information for developers:", diagnosticInfo);
                        } catch (reportError) {
                            console.error("Failed to generate diagnostic report:", reportError);
                        }
                    }

                    // Ask if user wants to reset the data
                    const shouldReset = await alertConfirm(language.bootstrap.resetLorebookQuestion);

                    if (shouldReset) {
                        v.lorebook = [];
                        console.log("Lorebook reset to empty array by user choice");
                    } else {
                        console.warn("User chose to keep corrupted lorebook data");
                    }
                } else {
                    v.lorebook = updateLorebooks(v.lorebook);
                }
            }
            return v;
        }),
    );

    db.modules = db.modules.filter((v) => {
        return v !== null && v !== undefined;
    });

    db.personas = (db.personas ?? [])
        .map((v) => {
            v.id ??= uuidv4();
            return v;
        })
        .filter((v) => {
            return v !== null && v !== undefined;
        });

    if (!db.formatversion) {
        function checkClean(data: string) {
            if (data.startsWith("assets") || data.length < 3) {
                return data;
            } else {
                const d = "assets/" + data.replace(/\\/g, "/").split("assets/")[1];
                if (!d) {
                    return data;
                }
                return d;
            }
        }

        db.customBackground = checkClean(db.customBackground);
        db.userIcon = checkClean(db.userIcon);

        for (let i = 0; i < db.characters.length; i++) {
            if (db.characters[i].image) {
                db.characters[i].image = checkClean(db.characters[i].image);
            }
            if (db.characters[i].emotionImages) {
                for (let i2 = 0; i2 < db.characters[i].emotionImages.length; i2++) {
                    if (db.characters[i].emotionImages[i2] && db.characters[i].emotionImages[i2].length >= 2) {
                        db.characters[i].emotionImages[i2][1] = checkClean(db.characters[i].emotionImages[i2][1]);
                    }
                }
            }
        }

        db.formatversion = 2;
    }
    if (db.formatversion < 3) {
        for (let i = 0; i < db.characters.length; i++) {
            let cha = db.characters[i];
            if (cha.type === "character") {
                if (checkNullish(cha.sdData)) {
                    cha.sdData = defaultSdDataFunc();
                }
            }
        }

        db.formatversion = 3;
    }
    if (db.formatversion < 4) {
        //migration removed due to issues
        db.formatversion = 4;
    }
    if (db.formatversion < 5) {
        if (db.loreBookToken < 8000) {
            db.loreBookToken = 8000;
        }
        db.formatversion = 5;
    }
    if (!db.characterOrder) {
        db.characterOrder = [];
    }
    if (db.mainPrompt === oldMainPrompt) {
        db.mainPrompt = defaultMainPrompt;
    }
    if (db.mainPrompt === oldJailbreak) {
        db.mainPrompt = defaultJailbreak;
    }
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
 * Assigns unique IDs to characters and chats.
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
        for (let i2 = 0; i2 < cha.chats.length; i2++) {
            const chat = cha.chats[i2];
            if (!chat.id) {
                chat.id = uuidv4();
            }
            if (assignedIds.has(chat.id)) {
                console.warn(`Duplicate chat ID found: ${chat.id}. Assigning new ID.`);
                chat.id = uuidv4();
            }
            assignedIds.add(chat.id);
        }
    }
}
