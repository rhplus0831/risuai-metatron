/**
 * The report of an upstream RisuAI `.bin` import (`docs/plan/upstream-bin-compat.md`): what the
 * converter (`server/src/data/upstream/importDatabase.ts`) kept, converted, or left out, shown to
 * the user before the import replaces anything. Codes are stable strings the client maps to
 * `language.*` text; an entry's `examples` are names (presets, fields, models), never values.
 */

/** Data the converter carried over in another shape. */
export const UPSTREAM_CONVERTED_CODES = [
    /** A reverse proxy key (`proxyKey`) became a named key, bound by the profiles that use the proxy. */
    "proxy-key-to-credential",
    /** A preset's own OpenAI key, which upstream no longer reads, became an unbound named key. */
    "preset-openai-key-to-credential",
    /** A custom model's key became a named key, bound by the profiles that use that model. */
    "custom-model-key-to-credential",
    /** A cold-storage character came back from its payload; examples are character names. */
    "cold-character-restored",
    /** A cold-storage chat came back from its payload, one per chat; examples are character names. */
    "cold-chat-restored",
    /** A plugin storage value came back from cold storage (`_coldplugin`); examples are storage keys. */
    "cold-plugin-storage-restored",
    /**
     * An upstream plugin storage value kept at the top level of `pluginCustomStorage` (upstream's v3
     * storage before it moved to cold storage) was also copied into metatron's v3 plugin storage;
     * examples are storage keys.
     */
    "legacy-plugin-storage",
    /** A character's invalid or repeated id was replaced by a new one; examples are names. */
    "character-id-replaced",
    /** A character's `postHistoryInstructions` moved into its selected chat's note; examples are names. */
    "post-history-instructions-to-note",
] as const;

/**
 * Data the converter did not import, or kept but cannot use (`plugin-unsupported-version`). Each
 * entry's `count` is in the unit its code names.
 */
export const UPSTREAM_EXCLUDED_CODES = [
    /** A root setting metatron does not know; the examples are field names. */
    "unknown-setting",
    /** The Risu Account login (`account`). */
    "risu-account",
    /** Saved loadouts (`loadouts`, `lastLoadedLoadoutName`). */
    "loadouts",
    /** A setting of a feature metatron removed, with a value set; the examples are field names. */
    "removed-feature",
    /** A setting or list entry the converter could not make valid; the examples are field paths. */
    "invalid-setting",
    /** A custom model with invalid required fields or rejected serialized data; examples are names or positions. */
    "invalid-custom-model",
    /**
     * A cold-storage pointer whose payload the backup lacks or holds unreadable (D3), one per pointer:
     * a character kept as its stub (name, image, an empty chat), a chat kept without its messages, or
     * a plugin storage value left out. Upstream's own backup never writes a plugin value that is not a
     * list or an object with `character` or `message`. Examples are character names or storage keys.
     */
    "cold-missing",
    /** A multiuser or playground leftover (`§temp`, `§playground`), one per character. */
    "temporary-character",
    /** A character or group left out with its chats (not an object, or refused); examples are names or positions. */
    "invalid-character",
    /** A chat left out with its messages, one per chat; examples are character names. */
    "invalid-chat",
    /** A module left out; examples are names or positions. */
    "invalid-module",
    /** A plugin left out; examples are names or positions. */
    "invalid-plugin",
    /**
     * A part of a kept character, chat, module, plugin, folder, or plugin storage reset to its default
     * or left out (a message, a lorebook entry, a field of the wrong kind, a stored translation), one
     * per repair; examples are names or field paths.
     */
    "invalid-data",
    /** A group member whose character was not imported, one per member; examples are group names. */
    "group-member-missing",
    /** An `enabledModules` entry naming no imported module's id or namespace; examples are the entries. */
    "module-reference-missing",
    /** A plugin kept but not run: metatron loads only plugin API 3.0; examples are plugin names. */
    "plugin-unsupported-version",
    /** Upstream keeps plugin data outside the backup (browser storage, permissions); reported once. */
    "plugin-device-storage",
    /** A chat that shows inlay images (`{{inlay::id}}`), which upstream keeps outside the backup, one per chat; examples are character names. */
    "inlays-not-in-backup",
    /** An archive record whose name has no asset storage location (too long, for example), one per record; examples are the names. */
    "asset-name-invalid",
] as const;

export type UpstreamConvertedCode = (typeof UPSTREAM_CONVERTED_CODES)[number];
export type UpstreamExcludedCode = (typeof UPSTREAM_EXCLUDED_CODES)[number];

/** How many names an entry lists; `count` still counts every occurrence. */
export const UPSTREAM_REPORT_EXAMPLE_LIMIT = 5;

export type UpstreamReportEntry<Code extends string = string> = {
    code: Code;
    /** Source occurrences of this conversion or exclusion, independent of credential deduplication. */
    count: number;
    examples: string[];
};

/**
 * Where a referenced asset key is used, on import and export alike (`server/src/data/upstream/assetReferences.ts`,
 * the one walker of both directions).
 */
export type UpstreamAssetRole =
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

/**
 * One referenced `assets/...` key and its first user (a character, group, persona, folder, preset, or
 * module name, a persona's for its embedded module; "" for a setting).
 */
export type UpstreamAssetReference = { key: string; owner: string; role: UpstreamAssetRole };

/**
 * A referenced asset the backup does not hold. `expected`: a non-`.png` key, which upstream never
 * puts in a backup (only its `.png` files are written), so its absence is no damage to the file.
 */
export type UpstreamMissingAsset = UpstreamAssetReference & { expected: boolean };

/** How many records of each category the converter produced. */
export type UpstreamImportCounts = {
    promptPresets: number;
    modelPresets: number;
    /** Converted profiles, without the materialized `default` profile. */
    modelProfiles: number;
    credentials: number;
    personas: number;
    customModels: number;
    /** Imported characters, groups excluded. */
    characters: number;
    groups: number;
    chats: number;
    messages: number;
    modules: number;
    plugins: number;
};

export type UpstreamImportReport = {
    counts: UpstreamImportCounts;
    converted: UpstreamReportEntry<UpstreamConvertedCode>[];
    excluded: UpstreamReportEntry<UpstreamExcludedCode>[];
    /**
     * Referenced assets the backup lacks, one per key (its first user), in reference order. Empty when
     * the converter was given no asset inventory (`assetKeys`).
     */
    missingAssets: UpstreamMissingAsset[];
};

/** The records the tab selects after the import (D4): the upstream-selected preset and persona. */
export type UpstreamImportSelection = {
    promptPresetId: string;
    modelPresetId: string;
    personaId: string;
};

export function createUpstreamImportReport(): UpstreamImportReport {
    return {
        counts: {
            promptPresets: 0,
            modelPresets: 0,
            modelProfiles: 0,
            credentials: 0,
            personas: 0,
            customModels: 0,
            characters: 0,
            groups: 0,
            chats: 0,
            messages: 0,
            modules: 0,
            plugins: 0,
        },
        converted: [],
        excluded: [],
        missingAssets: [],
    };
}

/**
 * Counts one occurrence of `code` in `list` (one entry per code, in first-occurrence order) and
 * records `example` while the entry lists fewer than `UPSTREAM_REPORT_EXAMPLE_LIMIT` names and
 * does not list it yet.
 */
export function addUpstreamReportEntry<Code extends string>(
    list: UpstreamReportEntry<Code>[],
    code: Code,
    example?: string,
): void {
    let entry = list.find((candidate) => candidate.code === code);
    if (!entry) {
        entry = { code, count: 0, examples: [] };
        list.push(entry);
    }
    entry.count += 1;
    if (
        example !== undefined &&
        entry.examples.length < UPSTREAM_REPORT_EXAMPLE_LIMIT &&
        !entry.examples.includes(example)
    ) {
        entry.examples.push(example);
    }
}

/**
 * The import routes (`server/src/routes/backupsUpstream.ts`, `docs/plan/upstream-bin-compat.md` S5):
 *
 * 1. Prepare: the `.bin` as the raw body. Archive refusals (a Risu Account backup among them) are a
 *    400 before anything streams; then the answer is NDJSON: `UpstreamImportProgress` lines, then one
 *    `UpstreamImportPrepared` line, or one `{ error }` line when the conversion failed (the live store
 *    is never touched by a prepare).
 * 2. Commit `{ token, acceptWrites? }`: replaces every resource with the staged store (full replace,
 *    U3) and answers `UpstreamImportCommitted`; `409 { error: UPSTREAM_CHANGED_SINCE_REVIEW, writes }`
 *    when resources were written since the prepare and `acceptWrites` does not name that count (D13).
 *    Or cancel `{ token }`: the staged import is removed.
 */
export const UPSTREAM_IMPORT_PREPARE_PATH = "/api/backups/import-upstream/prepare";
export const UPSTREAM_IMPORT_COMMIT_PATH = "/api/backups/import-upstream/commit";
export const UPSTREAM_IMPORT_CANCEL_PATH = "/api/backups/import-upstream/cancel";

/** How long a prepared import waits for its commit or cancel (from the prepare's answer). */
export const UPSTREAM_STAGED_TTL_MS = 10 * 60 * 1000;
/** How many prepared imports may wait at once; a prepare past it is a 409 `UPSTREAM_TOO_MANY_STAGED`. */
export const MAX_UPSTREAM_STAGED = 1;
/** A prepared import's token: a UUID. */
export const UPSTREAM_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The 404 `error` text of a commit whose prepared import is gone (expired, cancelled, or committed). */
export const UPSTREAM_IMPORT_EXPIRED = "Import expired";
/** The 409 `error` text of a prepare while another prepared import waits. */
export const UPSTREAM_TOO_MANY_STAGED = "Another RisuAI backup import is waiting for its answer";
/** The 409 `error` of a commit refused because resources were written since the prepare (D13). */
export const UPSTREAM_CHANGED_SINCE_REVIEW = "changedSinceReview";

/** The prepare's steps, in order; `assets` and `cold` count records, `write` counts chats. */
export const UPSTREAM_IMPORT_PHASES = ["decode", "cold", "convert", "write", "validate", "assets"] as const;
export type UpstreamImportPhase = (typeof UPSTREAM_IMPORT_PHASES)[number];

/** A prepare progress line: `done` of `total` items of `phase` (0 of 1 when it has no count). */
export type UpstreamImportProgress = { phase: UpstreamImportPhase; done: number; total: number };

/** The prepare's result line. */
export type UpstreamImportPrepared = {
    token: string;
    report: UpstreamImportReport;
    selection: UpstreamImportSelection;
};

/** The commit's answer: the new epoch, the assets added and kept, and the selection to apply (D4). */
export type UpstreamImportCommitted = {
    epoch: string;
    assetsWritten: number;
    assetsSkipped: number;
    selection: UpstreamImportSelection;
};
