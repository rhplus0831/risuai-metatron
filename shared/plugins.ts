// Installed plugin records persisted in the database (`plugins`).

interface ProviderPlugin {
    name: string;
    displayName?: string;
    script: string;
    arguments: { [key: string]: "int" | "string" | string[] };
    realArg: { [key: string]: number | string };
    version?: "3.0";
    customLink: ProviderPluginCustomLink[];
    argMeta: { [key: string]: { [key: string]: string } };
    versionOfPlugin?: string;
    updateURL?: string;
    enabled?: boolean;
    allowedIPC?: string[];
    /** Wait before remote-host completion notifications; read through `pluginCompletionQuietMs`, written by settings only, kept by `upsertPlugin`. */
    completionWait?: boolean;
    /** Required quiet time in seconds; read through `pluginCompletionQuietMs`, written by settings only, kept by `upsertPlugin`. */
    completionQuietSeconds?: number;
}

/** The range and default of a plugin's quiet time before a completion notification. */
export const PLUGIN_COMPLETION_QUIET_SECONDS = { min: 1, max: 60, default: 3 } as const;

/** Reads the stored opt-in and returns its defaulted, floored, clamped quiet time in milliseconds. */
export function pluginCompletionQuietMs(plugin: RisuPlugin | null | undefined): number | null {
    if (plugin?.completionWait !== true) return null;
    const seconds =
        typeof plugin.completionQuietSeconds === "number" && Number.isFinite(plugin.completionQuietSeconds)
            ? plugin.completionQuietSeconds
            : PLUGIN_COMPLETION_QUIET_SECONDS.default;
    return (
        Math.min(
            PLUGIN_COMPLETION_QUIET_SECONDS.max,
            Math.max(PLUGIN_COMPLETION_QUIET_SECONDS.min, Math.floor(seconds)),
        ) * 1000
    );
}

export interface ProviderPluginCustomLink {
    link: string;
    hoverText?: string;
}

/**
 * Installed plugin records. `src/ts/plugins/plugins.svelte.ts` imports only API `3.0`; legacy
 * records with another version (an upstream backup's `2` or `'2.1'`) or none remain persisted but
 * never load, despite the narrower `version` type. `src/lib/Setting/Pages/PluginSettings.svelte`
 * marks them unsupported. The internal `name` is the identity used for updates, arguments,
 * permissions, and IPC allowlists.
 */
export type RisuPlugin = ProviderPlugin;
