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

/**
 * A persona note's first non-blank line, trimmed, or `""`: what a one-line persona list shows. The
 * note is a multi-line memo that is never sent to the model.
 */
export function personaNoteFirstLine(note: unknown): string {
    if (typeof note !== "string") {
        return "";
    }
    return (
        note
            .split(/\r\n|\r|\n/)
            .find((line) => line.trim() !== "")
            ?.trim() ?? ""
    );
}

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
 * assigns ids at creation). `modules`, when present, is cleaned by `normalizePersonaModules` (an
entry without it stays without it). Other keys (`largePortrait`, `embeddedModule`, ...) are kept. Entries
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
        if (Object.hasOwn(persona, "modules")) {
            persona.modules = normalizePersonaModules(persona.modules);
        }
        return persona as unknown as RisuPersona;
    });
    return personas.length > 0 ? personas : [defaultPersona()];
}

/**
 * A persona's `modules` (the linked module ids) in canonical form: the non-blank strings of a list,
 * each once, in first-occurrence order; anything that is not a list becomes `[]`. Ids are kept
 * whether or not a module has them (the collection does not see the module list).
 */
export function normalizePersonaModules(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
}

/**
 * The module ids `persona` links, as an id set for the module resolvers (`getModules` on the tab,
 * `jobModules` on the server). A linked id matches a stored module by its `id` only (never by
 * `namespace`), and never an MCP module: the resolvers check `personaLinksModule`.
 */
export function personaModuleIdSet(persona: Pick<RisuPersona, "modules"> | null | undefined): ReadonlySet<string> {
    return new Set(normalizePersonaModules(persona?.modules));
}

/** Whether a persona link (`personaModuleIdSet`) activates `module`: by id, and not an MCP module. */
export function personaLinksModule(linked: ReadonlySet<string>, module: { id: string; mcp?: unknown }): boolean {
    return !module.mcp && linked.has(module.id);
}
