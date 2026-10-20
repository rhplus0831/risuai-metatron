import type { UpstreamReportEntry } from "./upstreamBackup.ts";

/**
 * The report of an upstream RisuAI `.bin` export (`docs/plan/upstream-bin-compat.md` S6): what the
 * exporter (`server/src/data/upstream/exportDatabase.ts`) carried over in another shape, what it left
 * out because upstream cannot hold it, and the referenced assets that are missing. Entries share the
 * import report's shape (`UpstreamReportEntry`, built with `addUpstreamReportEntry`): stable codes the
 * client maps to `language.*` text, and `examples` that are names (presets, fields, characters), never
 * values.
 */

/** Data the exporter carried over in another shape. */
export const UPSTREAM_EXPORT_CONVERTED_CODES = [
    /** Model presets other than the chosen one; every prompt preset is exported with the chosen one (D10). */
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
    /** API keys, left out because the export was made without them (D7); the examples are field names. */
    "api-keys",
    /** Named keys no exported field holds (upstream has no named keys); the examples are key names. */
    "named-keys",
    /** Sub/aux profile options lost to the main profile's options (D10); the examples are slot names. */
    "slot-options-flattened",
    /** metatron-only settings; the examples are field names. */
    "metatron-settings",
    /** metatron-only character fields; the examples are field names. */
    "character-fields",
    /** metatron-only chat fields (D12); counted per chat, the examples are field names. */
    "chat-fields",
    /** Stored message translations (D12); counted per message. */
    "message-translations",
    /** Persona module links; the examples are persona names. */
    "persona-modules",
    /** Translator pipeline settings upstream has no place for; the examples are preset names. */
    "translator-steps",
    /** Plugin storage upstream keeps outside the backup; counted per entry, the examples are plugin names. */
    "plugin-storage",
    /** Chats with inlay references (D8); the inlays are not exported. The examples are character names. */
    "inlays",
] as const;

export type UpstreamExportConvertedCode = (typeof UPSTREAM_EXPORT_CONVERTED_CODES)[number];
export type UpstreamExportExcludedCode = (typeof UPSTREAM_EXPORT_EXCLUDED_CODES)[number];

/** Where an exported record references an asset. */
export type UpstreamExportAssetRole =
    | "profile"
    | "emotion"
    | "additional"
    | "vits"
    | "ccAsset"
    | "sovitsReference"
    | "userIcon"
    | "background"
    | "persona"
    | "folder"
    | "preset"
    | "module"
    | "moduleIcon";

/** One referenced asset: its logical key (`assets/...`), the owner's name, and the reference's role. */
export type UpstreamExportAsset = { key: string; owner: string; role: UpstreamExportAssetRole };

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
    /** Referenced assets the export cannot carry because they do not exist. */
    missing: UpstreamExportAsset[];
};

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
