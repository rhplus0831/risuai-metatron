import { CharacterHandler as SharedCharacterHandler } from "../../../../../shared/mcp/risuaccess/characters.ts";
import { tabRisuAccessHost } from "./host";

/** The RisuAccess character tools in the tab: the shared handler over the tab's host. */
export class CharacterHandler extends SharedCharacterHandler {
    constructor() {
        super(tabRisuAccessHost);
    }
}
