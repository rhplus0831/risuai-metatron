/**
 * Result-key dependencies of every `jobScopeKinds` kind. This does not narrow the configuration
 * cache: its complete revision vector still guards the raw records used to build each projection.
 */
export const DISPLAY_KIND_CLASSIFICATION = {
    // Request, tokenizer and lore-activation settings: their Lua calls require safe/lowLevel
    // access, not editDisplay, and the display trigger allowlist offers none of those effects.
    providers: "drop",
    // Dynamic-asset embeddings read hypaCustomSettings and voyageApiKey.
    secrets: "keep",
    // Dynamic-asset embeddings read supaMemoryKey from the request projection.
    llmSecrets: "keep",
    // CBS reads jailbreakToggle/language; the asset tail reads dynamicAssetsEditDisplay.
    ui: "keep",
    // The dynamic-asset tail reads dynamicAssets and the embedding model hypaModel.
    memoryTranslateMedia: "keep",
    // The lore editor's library; display CBS/Lua read character, chat and module lore instead.
    loreBook: "drop",
    // The regex editor/import-export collection; display combines preset, character and module scripts.
    globalscript: "drop",
    // Browser keyboard bindings; no keyboard dispatch runs in the display transform.
    hotkeys: "drop",
    // Browser ordering; display resolves its owner, members, speakers and sources by id.
    characterOrder: "drop",
    // MCP authentication; the transform removes MCP and display exposes no tool calls.
    authRefreshes: "drop",
    // CBS/Lua global variables and the toggle resolver's legacy fallback: never drop.
    globalChatVariables: "keep",
    // Admission plus persona names, prompts, images and linked modules: never drop.
    personas: "keep",
    // The translation runner selects these; display runs no translation pipeline.
    translatorPresets: "drop",
    // The memory pipeline selects these; display runs no memory processing.
    hypaV3Presets: "drop",
    // Applying a saved toggle preset writes keyed chat metadata; display reads the resolved variables.
    togglePresets: "drop",
    // CBS model metadata and prefill support resolve custom model definitions.
    customModels: "keep",
    // Merged into LLM request settings; display Lua cannot request, and embeddings use their own keys.
    credentials: "drop",
    // Selects the modules supplying display scripts, lore, assets and toggle definitions.
    enabledModules: "keep",
    // Usage counters written by sends/imports; no display reader consumes them.
    statics: "drop",
    // Admission and CBS model selection: never drop.
    modelPresets: "keep",
    // Forwarded model/profile roots supply CBS model ids, context size and custom flags.
    modelProfiles: "keep",
    // Admission plus CBS prompt roots, regex and default/toggle variables: never drop.
    presets: "keep",
    // Display scripts, lore, assets and toggle definitions.
    modules: "keep",
    // Stored JSON without the top-level lastInteraction stamp, or `missing`, keyed per character.
    characters: "identity",
} as const satisfies Record<string, "keep" | "drop" | "identity">;

/** Non-character revisions in a display result key; an unclassified kind conservatively stays. */
export function isDisplayKeyKind(kind: string): boolean {
    return (
        !Object.hasOwn(DISPLAY_KIND_CLASSIFICATION, kind) ||
        DISPLAY_KIND_CLASSIFICATION[kind as keyof typeof DISPLAY_KIND_CLASSIFICATION] === "keep"
    );
}
