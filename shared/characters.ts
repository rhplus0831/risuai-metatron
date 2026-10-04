import type { character, groupChat } from "./database.ts";

/**
 * The character defaults (Phase 6 slice 5b, `character-ownership`): one pure helper the client applies
 * when a character is created or replaced whole and before it saves one, and the server's `characters`
 * normalizer applies on every write and in its startup pass. Only deterministic defaults live here: ids,
 * times, chats, the lorebook conversion, and the `postHistoryInstructions` transfer are creation steps
 * (`characterStore.svelte.ts`'s `prepareNewCharacter`).
 */

/** Thrown when a character's shape cannot be normalized (a group whose `characters` is not a list). */
export class CharacterShapeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CharacterShapeError";
    }
}

/** The default image-generation prompt table (a fresh copy each call). */
export function defaultSdData(): [string, string][] {
    return [
        ["always", "solo, 1girl"],
        ["negative", ""],
        ["|character's appearance", ""],
        ["current situation", ""],
        ["$character's pose", ""],
        ["$character's emotion", ""],
        ["current location", ""],
    ];
}

/** The `newGenData` a view screen implies (`updateInlayScreen`; a fresh object each call). */
export function inlayScreenGenData(
    viewScreen: unknown,
    inlay: unknown,
): { prompt: string; negative: string; instructions: string; emotionInstructions: string } {
    switch (viewScreen) {
        case "emotion":
            return inlay
                ? {
                      prompt: "",
                      negative: "",
                      instructions: "",
                      emotionInstructions: `You must always output the character's emotional image as a command at the end of a conversation. The command must be selected from a given list, and it's better to have variety than to repeat images used in previous chats. Use one image, depending on the character's emotion. See the list below. Form: <Emotion="<image command>"> Example: <Emotion="Agree"> List of commands: {{slot}}`,
                  }
                : {
                      prompt: "",
                      negative: "",
                      instructions: "",
                      emotionInstructions: `You must always output the character's emotional image as a command. The command must be selected from a given list, only output the command, depending on the character's emotion. List of commands: {{slot}}`,
                  };
        case "imggen":
            return inlay
                ? {
                      prompt: "best quality, {{slot}}",
                      negative: "worse quality",
                      instructions:
                          'You must always output the character\'s image as a keyword-formatted prompts that can be used in stable diffusion  at the end of a conversation. Use one image, depending on character, place, situation, etc. keyword should be long enough. Form: <ImgGen="<keyword-formatted prompt>">',
                      emotionInstructions: "",
                  }
                : {
                      prompt: "best quality, {{slot}}",
                      negative: "worse quality",
                      instructions:
                          "You must always output the character's image as a keyword-formatted prompts that can be used in stable diffusion. only output the that prompt, depending on character, place, situation, etc. keyword should be long enough.",
                      emotionInstructions: "",
                  };
        default:
            return {
                prompt: "",
                negative: "",
                instructions: "",
                emotionInstructions: "",
            };
    }
}

type Defaults = readonly (readonly [string, () => unknown])[];

const EVERY_CHARACTER: Defaults = [
    ["name", () => ""],
    ["firstMessage", () => ""],
    ["globalLore", () => []],
    ["customscript", () => []],
    ["emotionImages", () => []],
    ["viewScreen", () => "none"],
];

const SINGLE_CHARACTER: Defaults = [
    ["desc", () => ""],
    ["bias", () => []],
    ["sdData", defaultSdData],
    ["utilityBot", () => false],
    ["triggerscript", () => []],
    ["alternateGreetings", () => []],
    ["exampleMessage", () => ""],
    ["creatorNotes", () => ""],
    ["systemPrompt", () => ""],
    ["tags", () => []],
    ["creator", () => ""],
    ["characterVersion", () => ""],
    ["personality", () => ""],
    ["scenario", () => ""],
    ["firstMsgIndex", () => -1],
    ["additionalData", () => ({ tag: [], creator: "", character_version: "" })],
    ["voicevoxConfig", () => ({ SPEED_SCALE: 1, PITCH_SCALE: 0, INTONATION_SCALE: 1, VOLUME_SCALE: 1 })],
    ["additionalText", () => ""],
    ["depth_prompt", () => ({ depth: 0, prompt: "" })],
    ["hfTTS", () => ({ model: "", language: "en" })],
    ["backgroundHTML", () => ""],
    ["backgroundCSS", () => ""],
    ["ttsMode", () => ""],
];

const missing = (value: unknown) => value === undefined || value === null;

/**
 * A character with its defaults: a new object (the input is not changed) with the input's own fields
 * in their order, each default set only where the field is `undefined` or `null` (a field that was
 * absent is appended, in the fixed order above). Never touches `chats`, `chatPage`, `reloadKeys`, or
 * `chaId`. One exception to "missing fields only": a group's `characterTalks` and `characterActive`
 * are rebuilt (every weight and flag reset) when they are not lists as long as its `characters`.
 * Idempotent. Throws `CharacterShapeError` for a group whose `characters` is set but not a list.
 */
export function normalizeCharacter<T extends character | groupChat | Record<string, unknown>>(input: T): T {
    const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    const fill = (defaults: Defaults) => {
        for (const [field, make] of defaults) {
            if (missing(out[field])) {
                out[field] = make();
            }
        }
    };
    if (missing(out.type)) {
        out.type = "character";
    }
    fill(EVERY_CHARACTER);
    if (out.type === "group") {
        if (missing(out.characters)) {
            out.characters = [];
        }
        if (!Array.isArray(out.characters)) {
            throw new CharacterShapeError("a group's characters must be a list");
        }
        const members = out.characters.length;
        if (!Array.isArray(out.characterTalks) || out.characterTalks.length !== members) {
            out.characterTalks = Array.from({ length: members }, () => (1 / 6) * 4);
        }
        if (!Array.isArray(out.characterActive) || out.characterActive.length !== members) {
            out.characterActive = Array.from({ length: members }, () => true);
        }
    } else {
        fill(SINGLE_CHARACTER);
        if (missing(out.newGenData)) {
            out.newGenData = inlayScreenGenData(out.viewScreen, out.inlayViewScreen);
        }
    }
    return out as T;
}
