import { ModuleShapeError, normalizeModule } from "../../../../shared/modules.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { requireArrayOfObjects } from "./shared.ts";

/**
 * The `modules` record (Phase 6 slice 4): a list of module objects, each with the shape the client's
 * mutations check too (`normalizeModule`, `shared/modules.ts`; the client assigns ids). A malformed
 * module (a non-string name or description, a non-list lorebook, regex, or trigger) refuses the
 * write; nothing is dropped, and a valid list is returned unchanged.
 */
export function normalizeModules(input: unknown): unknown[] {
    const list = requireArrayOfObjects(input, "modules");
    list.forEach((module, index) => {
        try {
            normalizeModule(module);
        } catch (error) {
            if (error instanceof ModuleShapeError) {
                throw new ResourceValidationError(`modules[${index}]: ${error.message}`);
            }
            throw error;
        }
    });
    return list;
}
