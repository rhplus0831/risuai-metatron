import { CharacterShapeError, normalizeCharacter } from "../../../../shared/characters.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { requireObject } from "./shared.ts";

/**
 * The `characters` normalizer (Phase 6 slice 5b): a character record is an object whose `chaId` is its
 * resource id and which holds no chats (they live in the chat tables, Phase 2), with the shared
 * deterministic defaults filled in (`normalizeCharacter`, `shared/characters.ts`; idempotent, so the
 * startup pass rewrites a stored character once). A group whose `characters` is not a list is refused.
 * The kind is `shallowNormalize`: nothing given is changed, and every field not replaced is kept by reference.
 */
export function normalizeCharacterRecord(input: unknown, id: string): Record<string, unknown> {
    const character = requireObject(input, "character");
    if (character.chaId !== id) {
        throw new ResourceValidationError("character.chaId must equal the resource id");
    }
    if (Object.hasOwn(character, "chats")) {
        throw new ResourceValidationError("character must not hold chats");
    }
    try {
        return normalizeCharacter(character);
    } catch (error) {
        if (error instanceof CharacterShapeError) {
            throw new ResourceValidationError(`character: ${error.message}`);
        }
        throw error;
    }
}
