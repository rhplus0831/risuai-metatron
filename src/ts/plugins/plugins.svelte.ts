import { settings } from "../storage/settingsViews.svelte";
import { language } from "../../lang";
import { upsertPlugin } from "../storage/collectionStore.svelte";
import { alertConfirm, alertError } from "../alert";
import { selectSingleFile } from "../util";
import { hotReloading } from "../stores.svelte";
import { loadV3Plugins, onPluginWorkChange, pluginWorkIdle } from "./apiV3/v3.svelte";
import { pluginCodeTranspiler } from "./apiV3/transpiler";
import { clearPluginHooks } from "./pluginHooks";
import { onRemoteRecordApplied } from "../storage/resourceSync.svelte";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import type { RisuPlugin, ProviderPluginCustomLink } from "../../../shared/plugins.ts";

export type { RisuPlugin } from "../../../shared/plugins.ts";

export async function createBlankPlugin() {
    await importPlugin(
        `
//@name New Plugin
//@display-name New Plugin Display Name
//@api 3.0
//@arg example_arg string

Risuai.log("Hello from New Plugin!");
`.trim(),
    );
}

const compareVersions = (v1: string, v2: string): 0 | 1 | -1 => {
    const v1parts = v1.split(".").map(Number);
    const v2parts = v2.split(".").map(Number);
    const len = Math.max(v1parts.length, v2parts.length);
    for (let i = 0; i < len; i++) {
        const part1 = v1parts[i] || 0;
        const part2 = v2parts[i] || 0;
        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }
    return 0;
};

const updateCache = new Map<string, { version: string; updateURL: string } | undefined>();

export const checkPluginUpdate = async (plugin: RisuPlugin) => {
    try {
        if (!plugin.updateURL) {
            return;
        }

        if (updateCache.has(plugin.name)) {
            const cached = updateCache.get(plugin.name);
            if (compareVersions(cached.version, plugin.versionOfPlugin || "0.0.0") === 1) {
                return cached;
            }
        }

        const response = await fetch(plugin.updateURL, {
            method: "GET",
            headers: {
                Range: "bytes=0-512",
            },
        });

        if (response.status >= 200 && response.status < 300) {
            const text = await response.text();
            const versioRegex = /\/\/@version\s+([^\s]+)/;
            const match = text.match(versioRegex);
            if (match && match[1]) {
                const latestVersion = match[1].trim();
                if (compareVersions(latestVersion, plugin.versionOfPlugin || "0.0.0") === 1) {
                    updateCache.set(plugin.name, {
                        version: latestVersion,
                        updateURL: plugin.updateURL,
                    });
                    return {
                        version: latestVersion,
                        updateURL: plugin.updateURL,
                    };
                }
            }
        }
    } catch (error) {
        console.warn("Failed to check plugin update:", error);
    }
};

export async function updatePlugin(plugin: RisuPlugin) {
    try {
        if (!plugin.updateURL) {
            return false;
        }
        const response = await fetch(plugin.updateURL);
        if (response.status >= 200 && response.status < 300) {
            const jsFile = await response.text();
            await importPlugin(jsFile, {
                isUpdate: true,
                originalPluginName: plugin.name,
            });
            return true;
        }
    } catch (error) {
        console.error("Failed to update plugin:", error);
    }
    return false;
}

export async function importPlugin(
    code: string | null = null,
    argu: {
        isUpdate?: boolean;
        originalPluginName?: string;
        isHotReload?: boolean;
        isTypescript?: boolean;
    } = {},
) {
    try {
        let jsFile = "";
        let isUpdate = argu.isUpdate || false;
        let originalPluginName = argu.originalPluginName || "";
        let isTypescript = argu.isTypescript || false;

        if (!code) {
            const f = await selectSingleFile(["js", "ts"]);
            if (!f) {
                return;
            }
            if (f.name.endsWith(".ts")) {
                isTypescript = true;
            }
            //support utf-8 with BOM or without BOM
            jsFile = Buffer.from(f.data)
                .toString("utf-8")
                .replace(/^\uFEFF/gm, "");
        } else {
            jsFile = code;
        }

        const splitedJs = jsFile.split("\n");
        let name = "";
        for (const line of splitedJs) {
            if (line.startsWith("//@name")) {
                name = line.slice(7).trim();
                break;
            }
        }

        const showError = (msg: string) => {
            if (argu.isHotReload) {
                console.error(`Hot-reload plugin "${name}" error: ${msg}`);
            } else {
                alertError(msg);
            }
        };

        let displayName: string = undefined;
        let arg: { [key: string]: "int" | "string" | string[] } = {};
        let realArg: { [key: string]: number | string } = {};
        let argMeta: { [key: string]: { [key: string]: string } } = {};
        let customLink: ProviderPluginCustomLink[] = [];
        let updateURL: string = "";
        let versionOfPlugin: string = ""; //This is the version of the plugin itself, not the API version
        let hasSupportedApi = false;
        let ipcList: string[] = [];
        for (const line of splitedJs) {
            if (line.startsWith("//@name")) {
                const provied = line.slice(7);
                if (provied === "") {
                    showError("plugin name must be longer than 0, did you put it correctly?");
                    return;
                }
                name = provied.trim();
            }
            if (line.startsWith("//@api")) {
                const proviedVersions = line.slice(6).trim().split(" ");
                for (const ver of proviedVersions) {
                    if (ver === "3.0") {
                        hasSupportedApi = true;
                        break;
                    } else {
                        console.warn(`Plugin API version "${ver}" is not supported.`);
                    }
                }
            }
            if (line.startsWith("//@display-name")) {
                const provied = line.slice("//@display-name".length + 1);
                if (provied === "") {
                    showError("plugin display name must be longer than 0, did you put it correctly?");
                    return;
                }
                displayName = provied.trim();
            }

            if (line.startsWith("//@link")) {
                const link = line.split(" ")[1];
                if (!link || link === "") {
                    showError("plugin link is empty, did you put it correctly?");
                    return;
                }
                if (!link.startsWith("https")) {
                    showError("plugin link must start with https, did you check it?");
                    return;
                }
                const hoverText = line.split(" ").slice(2).join(" ").trim();
                if (hoverText === "") {
                    // OK, no hover text. It's fine.
                    customLink.push({
                        link: link,
                        hoverText: undefined,
                    });
                } else
                    customLink.push({
                        link: link,
                        hoverText: hoverText || undefined,
                    });
            }
            if (line.startsWith("//@risu-arg") || line.startsWith("//@arg")) {
                const provied = line.trim().split(" ");
                if (provied.length < 3) {
                    showError("plugin argument is incorrect, did you put space in argument name?");
                    return;
                }
                const provKey = provied[1];

                if (provied[2] !== "int" && provied[2] !== "string") {
                    showError(`plugin argument type is "${provied[2]}", which is an unknown type.`);
                    return;
                }
                if (provied[2] === "int") {
                    arg[provKey] = "int";
                    realArg[provKey] = 0;
                } else if (provied[2] === "string") {
                    arg[provKey] = "string";
                    realArg[provKey] = "";
                }

                if (provied.length > 3) {
                    const meta: { [key: string]: string } = {};
                    //Compatibility layer for unofficial meta
                    let metaStr = provied
                        .slice(3)
                        .join(" ")
                        .replace(/{{(.+?)(::?(.+?))?}}/g, (a, g1: string, g2, g3: string) => {
                            console.log(g1, g3);
                            meta[g1] = g3 || "1";
                            return "";
                        })
                        .trim();

                    if (metaStr) {
                        meta["description"] = metaStr;
                    }

                    argMeta[provKey] = meta;
                }
            }

            if (line.startsWith("//@update-url")) {
                updateURL = line.split(" ")[1];

                try {
                    const url = new URL(updateURL);
                    if (url.protocol !== "https:") {
                        showError("plugin update URL must start with https, did you put it correctly?");
                        return;
                    }
                } catch (error) {
                    showError("plugin update URL is not a valid URL, did you put it correctly?");
                    return;
                }
            }

            if (line.startsWith("//@version")) {
                versionOfPlugin = line.split(" ").slice(1).join(" ").trim();

                const versionLocation = jsFile.indexOf("//@version");
                const numberOfBytesBefore = new TextEncoder().encode(jsFile.slice(0, versionLocation) + line).length;
                if (numberOfBytesBefore > 500) {
                    showError(
                        "plugin version declaration must be within the first 512 Bytes of the file for proper parsing. move //@version line to the top of the file.",
                    );
                    return;
                }
            }

            if (line.startsWith("//@allowed-ipc")) {
                const provied = line.trim().split(" ");
                if (provied.length < 2) {
                    showError("plugin allowed IPC declaration is incorrect, did you put space after //@allowed-ipc?");
                    return;
                }

                const allowedIPCList = provied.slice(1);

                ipcList.push(...allowedIPCList);
            }
        }

        if (name.length === 0) {
            showError("plugin name not found, did you put it correctly?");
            return;
        }

        if (updateURL && versionOfPlugin.length === 0) {
            showError(
                "plugin version not found, did you put it correctly? It is required when update URL is provided.",
            );
            return;
        }

        if (versionOfPlugin && compareVersions(versionOfPlugin, "0.0.1") === -1) {
            showError("plugin version must be at least 0.0.1");
            return;
        }

        if (isTypescript) {
            try {
                jsFile = await pluginCodeTranspiler(jsFile);
            } catch (error) {
                showError("Failed to transpile TypeScript code: " + error.message);
            }
        }

        if (!hasSupportedApi) {
            showError(language.pluginApiVersionUnsupported);
            return;
        }

        let pluginData: RisuPlugin = {
            name: name,
            script: jsFile,
            realArg: realArg,
            arguments: arg,
            displayName: displayName,
            version: "3.0",
            customLink: customLink,
            argMeta: argMeta,
            versionOfPlugin: versionOfPlugin,
            updateURL: updateURL,
            allowedIPC: ipcList,
            enabled: true,
        };

        const oldPluginIndex = (settings.plugins ?? []).findIndex((p: RisuPlugin) => p.name === pluginData.name);

        if (originalPluginName && originalPluginName !== pluginData.name) {
            showError(
                `When updating plugin "${originalPluginName}", the plugin name cannot be changed to "${pluginData.name}". Please keep the original name to update.`,
            );
            return;
        }

        if (!isUpdate && oldPluginIndex !== -1) {
            const c = await alertConfirm(language.duplicatePluginFoundUpdateIt);
            if (!c) {
                return;
            }
        }

        // Replaces the installed plugin with this name, or installs it.
        if (oldPluginIndex !== -1 || !isUpdate || argu.isHotReload) {
            upsertPlugin(pluginData);
        }

        if (argu.isHotReload && !hotReloading.includes(pluginData.name)) {
            hotReloading.push(pluginData.name);
        }

        console.log(`Imported plugin: ${pluginData.name} (API v3.0)`);

        loadPlugins();
    } catch (error) {
        console.error(error);
        alertError(language.errors.noData);
    }
}

let pluginReload: Promise<void> = Promise.resolve();

// Identities (name, API version, script hash) of the non-3.0 plugins already reported in this page load.
const reportedUnsupportedPlugins = new Set<string>();

async function unsupportedPluginIdentity(plugin: RisuPlugin): Promise<string> {
    const script = plugin.script ?? "";
    let scriptId = script;
    try {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
        scriptId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (error) {
        console.error(error);
    }
    return JSON.stringify([plugin.name, String(plugin.version ?? ""), scriptId]);
}

/** Reports each enabled plugin that does not load (not API 3.0) once per page load and identity. */
async function reportUnsupportedPlugins(plugins: readonly RisuPlugin[]): Promise<void> {
    const identities = await Promise.all(plugins.map(unsupportedPluginIdentity));
    // From here on synchronous, so concurrent loads with the same plugins report them once.
    const unreported = new Map<string, RisuPlugin>();
    plugins.forEach((plugin, i) => {
        if (!reportedUnsupportedPlugins.has(identities[i])) unreported.set(identities[i], plugin);
    });
    if (unreported.size === 0) return;
    const listed = Array.from(
        unreported.values(),
        (plugin) => `${plugin.displayName ?? plugin.name} (API ${plugin.version ?? "?"})`,
    ).join("\n");
    const message = language.pluginApiVersionUnsupportedLoad.replace("{plugins}", listed);
    if (hotReloading.length > 0) console.error(message);
    else alertError(message);
    for (const identity of unreported.keys()) reportedUnsupportedPlugins.add(identity);
}

/**
 * What `loadV3Plugins` captures of each plugin it starts: its name and script, and the `allowedIPC`
 * its own channel messages are checked against. Arguments (`realArg`) are read live, so another
 * device's `setArgument` needs no reload.
 */
function loadSignature(plugins: readonly RisuPlugin[]): string {
    return JSON.stringify(plugins.map((p) => [p.name, p.script, p.allowedIPC ?? []]));
}

/** The load signature of the plugins running now: null before the first load and while a reload replaces them. */
let appliedSignature: string | null = null;
let pendingLocalLoads = 0;

/** Clears and reloads the hooks with `plugins`; runs on the `pluginReload` chain only. */
async function applyPluginLoad(plugins: RisuPlugin[]) {
    appliedSignature = null;
    clearPluginHooks();
    await loadV3Plugins(plugins);
    appliedSignature = loadSignature(plugins);
}

/*
 * The reload after a remote `plugins` change (RisuNest small wins P2, `plugins-mcp.md` Flows): another
 * tab or device disabled, removed, or updated a plugin that runs here. It waits until no plugin work is
 * in flight (`pluginWorkIdle`; decision D4: never interrupted), checks again on the `pluginReload` chain
 * right before it clears anything, and loads the list as it is then. One at a time: changes while it
 * waits only make it load the newest list. A local `loadPlugins` supersedes it.
 */
let watchingRemotePlugins = false;
let deferredWanted = false;
let deferredQueued = false;
let deferredCheckQueued = false;
let deferredGeneration = 0;
let watchingPluginWork = false;

function watchRemotePlugins() {
    if (watchingRemotePlugins) {
        return;
    }
    watchingRemotePlugins = true;
    onRemoteRecordApplied((kind) => {
        if (kind !== RESOURCE_KIND.plugins) {
            return;
        }
        // A change to a disabled or a non-3.0 plugin, or to what is read live, changes nothing loaded.
        if (pendingLocalLoads === 0 && loadSignature(loadablePlugins()) === appliedSignature) {
            return;
        }
        deferredWanted = true;
        if (!watchingPluginWork) {
            watchingPluginWork = true;
            onPluginWorkChange(queueDeferredCheck);
        }
        queueDeferredCheck();
    });
}

function loadablePlugins(): RisuPlugin[] {
    return safeStructuredClone(settings.plugins).filter((p: RisuPlugin) => p.enabled && p.version === "3.0");
}

/** Checks once per microtask whether the wanted reload can start (activity notifications come in bursts). */
function queueDeferredCheck() {
    if (!deferredWanted || deferredQueued || deferredCheckQueued) {
        return;
    }
    deferredCheckQueued = true;
    queueMicrotask(() => {
        deferredCheckQueued = false;
        if (!deferredWanted || deferredQueued || !pluginWorkIdle()) {
            return;
        }
        deferredWanted = false;
        deferredQueued = true;
        const generation = deferredGeneration;
        const reload = pluginReload.then(async () => {
            if (generation !== deferredGeneration) {
                return;
            }
            // Plugin work may have started while this waited behind another reload: wait again.
            if (!pluginWorkIdle()) {
                deferredWanted = true;
                return;
            }
            const plugins = loadablePlugins();
            if (loadSignature(plugins) === appliedSignature) {
                return;
            }
            // Synchronous from the idle check to the hook reset.
            await applyPluginLoad(plugins);
        });
        pluginReload = reload.catch(() => {});
        void reload
            .catch((error) => console.error(error))
            .finally(() => {
                deferredQueued = false;
                queueDeferredCheck();
            });
    });
}

export async function loadPlugins() {
    console.log("Loading plugins...");
    watchRemotePlugins();
    // This load reads the list as it is now, remote changes included: a waiting deferred reload is not needed.
    deferredWanted = false;
    deferredGeneration++;

    const enabled = safeStructuredClone(settings.plugins).filter((p: RisuPlugin) => p.enabled);
    const enabledPlugins = enabled.filter((p: RisuPlugin) => p.version === "3.0");
    const report = reportUnsupportedPlugins(enabled.filter((p: RisuPlugin) => p.version !== "3.0")).catch((error) =>
        console.error(error),
    );

    // Capture each caller's list now, but reset and reload only after the previous reload settles.
    pendingLocalLoads++;
    const reload = pluginReload
        .then(() => applyPluginLoad(enabledPlugins))
        .finally(() => {
            pendingLocalLoads--;
            queueDeferredCheck();
        });
    pluginReload = reload.catch(() => {});
    await report;
    await reload;
}

export const allowedDbKeys = [
    "characters",
    "modules",
    "enabledModules",
    "moduleIntergration",
    "personas",
    "plugins",
    "pluginCustomStorage",
    "temperature",
    "askRemoval",
    "maxContext",
    "maxResponse",
    "frequencyPenalty",
    "PresensePenalty",
    "theme",
    "textTheme",
    "lineHeight",
    "seperateModelsForAxModels",
    "seperateModels",
    "customCSS",
    "guiHTML",
    "colorSchemeName",
    "selectedPersona",
    "characterOrder",
];

export async function handlePluginInstallViaPlugin(plugins: RisuPlugin[]) {
    const trimmedPlugins: RisuPlugin[] = [];
    for (const plugin of plugins) {
        if (!settings.plugins.find((p: RisuPlugin) => p.name === plugin.name && p.script === plugin.script)) {
            if (plugin.version !== "3.0") {
                console.warn(
                    `Plugin "${plugin.name}" has version "${plugin.version}", which is not supported for installation via plugin. Only API version 3.0 plugins can be installed via plugin. Skipping installation of this plugin.`,
                );
                continue;
            }
            const confirmation = await alertConfirm(
                language.confirmInstallPluginViaPlugin.replace("{plugin}", plugin.name),
            );
            if (confirmation) {
                trimmedPlugins.push(plugin);
            }
        } else {
            console.warn(`Plugin "${plugin.name}" already exists, skipping installation via plugin.`);
        }
    }

    return trimmedPlugins;
}
