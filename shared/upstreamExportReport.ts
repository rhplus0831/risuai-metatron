import type { UpstreamAssetReference, UpstreamReportEntry } from "./upstreamBackup.ts";

/**
 * The report of an upstream RisuAI `.bin` export: what the exporter
 * (`server/src/data/upstream/exportDatabase.ts`) carried over in another shape, what it left out
 * because upstream cannot hold it, and the referenced assets that are missing. Entries share the
 * import report's shape (`UpstreamReportEntry`, built with `addUpstreamReportEntry`): stable codes
 * the client maps to `language.*` text, and `examples` that are names (presets, fields,
 * characters), never values.
 */

/** Data the exporter carried over in another shape. */
export const UPSTREAM_EXPORT_CONVERTED_CODES = [
    /** Model presets other than the chosen one; every prompt preset is exported with the chosen one. */
    "model-presets-flattened",
    /** A requested prompt preset, model preset, or persona no longer exists; the first record was used. */
    "selection-fallback",
    /** A named key a chosen slot binds was written into the upstream field that model reads. */
    "named-key-to-field",
    /** A translator preset's first enabled step became upstream's single prompt. */
    "translator-steps-flattened",
    /** A trashed character's trash time was refreshed, so upstream's boot does not delete it at once. */
    "trash-time-refreshed",
    /** A list or entry upstream's boot would fail on was repaired in the export; the examples are paths. */
    "shape-repaired",
] as const;

/** Data the exporter did not export. */
export const UPSTREAM_EXPORT_EXCLUDED_CODES = [
    /** API keys, left out because the export was made without them; the examples are field names. */
    "api-keys",
    /** Named keys no exported field holds (upstream has no named keys); the examples are key names. */
    "named-keys",
    /** Sub/aux profile options lost to the main profile's options; the examples are slot names. */
    "slot-options-flattened",
    /** metatron-only settings; the examples are field names. */
    "metatron-settings",
    /** metatron-only character fields; the examples are field names. */
    "character-fields",
    /** metatron-only chat fields; counted per chat, the examples are field names. */
    "chat-fields",
    /** Stored message translations; counted per message. */
    "message-translations",
    /** Persona module links; the examples are persona names. */
    "persona-modules",
    /** Translator pipeline settings upstream has no place for; the examples are preset names. */
    "translator-steps",
    /** Plugin storage upstream keeps outside the backup; counted per entry, the examples are plugin names. */
    "plugin-storage",
    /** Chats with inlay references; the inlays are not exported. The examples are character names. */
    "inlays",
    /**
     * Referenced assets whose file name a RisuAI backup record cannot hold (a `/`, or a name upstream's
     * restore reads as its database or as cold storage); added by the export route, the examples are keys.
     */
    "asset-names",
] as const;

export type UpstreamExportConvertedCode = (typeof UPSTREAM_EXPORT_CONVERTED_CODES)[number];
export type UpstreamExportExcludedCode = (typeof UPSTREAM_EXPORT_EXCLUDED_CODES)[number];

/** How many records of each category the export holds. */
export type UpstreamExportCounts = {
    /** Characters, groups included. */
    characters: number;
    groups: number;
    chats: number;
    messages: number;
    promptPresets: number;
    personas: number;
    modules: number;
    plugins: number;
    /** Referenced assets that exist (`missing` lists the others). */
    assets: number;
};

export type UpstreamExportReport = {
    counts: UpstreamExportCounts;
    converted: UpstreamReportEntry<UpstreamExportConvertedCode>[];
    excluded: UpstreamReportEntry<UpstreamExportExcludedCode>[];
    /** Referenced assets the export cannot carry because they do not exist (the import's walker and roles). */
    missing: UpstreamAssetReference[];
};

/**
 * The export routes (`server/src/routes/backupsUpstreamExport.ts`):
 *
 * 1. Prepare `UpstreamExportRequest`: one consistent copy of the store projected and encoded into
 *    `database.risudat`, kept on the server under a token; answers `UpstreamExportPrepared`.
 * 2. Download `?token=`: the referenced assets as basename records, then `database.risudat`, in the
 *    archive container upstream's "Load Backup" reads. The token is used up when the download starts.
 *    Or cancel `{ token }`: the prepared export is removed.
 */
export const UPSTREAM_EXPORT_PREPARE_PATH = "/api/backups/export-upstream/prepare";
export const UPSTREAM_EXPORT_DOWNLOAD_PATH = "/api/backups/export-upstream/download";
export const UPSTREAM_EXPORT_CANCEL_PATH = "/api/backups/export-upstream/cancel";

/** How long a prepared export waits for its download or cancel (from the prepare's answer). */
export const UPSTREAM_EXPORT_STAGED_TTL_MS = 10 * 60 * 1000;
/** How many prepared exports may wait at once; a prepare past it is a 409 `UPSTREAM_EXPORT_TOO_MANY_STAGED`. */
export const MAX_UPSTREAM_EXPORTS_STAGED = 4;
/** The 404 `error` text of a download whose prepared export is gone (expired, cancelled, or downloaded). */
export const UPSTREAM_EXPORT_EXPIRED = "Export expired";
/** The 409 `error` text of a prepare while `MAX_UPSTREAM_EXPORTS_STAGED` prepared exports wait. */
export const UPSTREAM_EXPORT_TOO_MANY_STAGED = "Other RisuAI-compatible backups are waiting for their download";

/** The prepare's body: the tab's selection, whether to export the API keys, and its open chat. */
export type UpstreamExportRequest = {
    promptPresetId: string;
    modelPresetId: string;
    personaId: string;
    includeSecrets: boolean;
    selectedChat?: { characterId: string; chatId: string };
};

/** The prepare's answer. */
export type UpstreamExportPrepared = { token: string; report: UpstreamExportReport };

export function createUpstreamExportReport(): UpstreamExportReport {
    return {
        counts: {
            characters: 0,
            groups: 0,
            chats: 0,
            messages: 0,
            promptPresets: 0,
            personas: 0,
            modules: 0,
            plugins: 0,
            assets: 0,
        },
        converted: [],
        excluded: [],
        missing: [],
    };
}
