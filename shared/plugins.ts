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
