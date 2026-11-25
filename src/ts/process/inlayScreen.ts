import type { character } from "../storage/database.svelte";
import { inlayScreenGenData } from "../../../shared/characters.ts";

export function updateInlayScreen(char: character): character {
    char.newGenData = inlayScreenGenData(char.viewScreen, char.inlayViewScreen);
    return char;
}
