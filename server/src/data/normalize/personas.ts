import type { RisuPersona } from "../../../../shared/database.ts";
import { normalizePersonas as normalizePersonaList } from "../../../../shared/personas.ts";
import { requireArrayOfObjects } from "./shared.ts";

/**
 * The `personas` collection (`shared/personas.ts`, which the client applies too): never empty, every
 * entry with its four string fields and a unique id. A missing record becomes the fresh-boot
 * persona; an entry that is not an object is rejected.
 */
export function normalizePersonas(input: unknown): RisuPersona[] {
    return normalizePersonaList(input === undefined ? [] : requireArrayOfObjects(input, "personas"));
}
