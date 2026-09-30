import type { RisuPersona } from "../../../../shared/database.ts";
import { isRecordId } from "../../../../shared/ids.ts";
import { newPersonaId } from "../../../../shared/presets.ts";
import { plainClone, requireArrayOfObjects } from "./shared.ts";

/**
 * The `personas` collection. Every persona keeps its fields and gets an id when it has no valid one
 * or repeats an earlier one (a backstop: the client assigns ids at creation). A missing record
 * becomes the fresh-boot persona; an empty list stays empty.
 */
export function normalizePersonas(input: unknown): RisuPersona[] {
    if (input === undefined) {
        return [{ name: "User", personaPrompt: "", icon: "", note: "", largePortrait: false, id: newPersonaId() }];
    }
    const seen = new Set<string>();
    return requireArrayOfObjects(input, "personas").map((entry) => {
        const persona = plainClone(entry);
        if (!isRecordId(persona.id) || seen.has(persona.id)) {
            persona.id = newPersonaId();
        }
        seen.add(persona.id as string);
        return persona as unknown as RisuPersona;
    });
}
