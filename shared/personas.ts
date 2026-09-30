import type { RisuPersona } from "./database.ts";
import { isRecordId } from "./ids.ts";
import { newPersonaId, plainClone } from "./presets.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * The four persona fields the forwarding layer serves as `username`, `userIcon`, `personaPrompt`,
 * and `userNote`, with the value a persona that lacks one gets (the fresh-boot persona's).
 */
export const PERSONA_DEFAULTS = {
    name: "User",
    icon: "",
    personaPrompt: "",
    note: "",
} as const satisfies Partial<Record<keyof RisuPersona, string>>;

/** The persona a fresh boot, or an empty collection, gets. */
export function defaultPersona(): RisuPersona {
    return { name: "User", personaPrompt: "", icon: "", note: "", largePortrait: false, id: newPersonaId() };
}

/**
 * The normalized `personas` collection, applied alike by the server normalizer and the client
 * (`setDatabase`), so the text is a fixed point: never empty (an empty or missing list becomes the
 * default persona, so a selection always has a record), every entry with the four
 * `PERSONA_DEFAULTS` fields as strings (a missing or wrong-typed one gets its default, appended
 * after the entry's own keys) and a valid id not used by an earlier entry (a backstop: the client
 * assigns ids at creation). Other keys (`largePortrait`, `embeddedModule`, ...) are kept. Entries
 * that are not objects are dropped (the server rejects them before this runs). The input is not
 * mutated and must be plain data.
 */
export function normalizePersonas(input: unknown): RisuPersona[] {
    const source = Array.isArray(input) ? input.filter(isPlainObject) : [];
    const seen = new Set<string>();
    const personas = source.map((entry) => {
        const persona = plainClone(entry) as Record<string, unknown>;
        for (const [field, fallback] of Object.entries(PERSONA_DEFAULTS)) {
            if (typeof persona[field] !== "string") {
                persona[field] = fallback;
            }
        }
        if (!isRecordId(persona.id) || seen.has(persona.id)) {
            persona.id = newPersonaId();
        }
        seen.add(persona.id as string);
        return persona as unknown as RisuPersona;
    });
    return personas.length > 0 ? personas : [defaultPersona()];
}
