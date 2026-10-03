import { ChatHandler as SharedChatHandler } from "../../../../../shared/mcp/risuaccess/chats.ts";
import { tabRisuAccessHost } from "./host";

/** The RisuAccess chat tools in the tab: the shared handler over the tab's host. */
export class ChatHandler extends SharedChatHandler {
    constructor() {
        super(tabRisuAccessHost);
    }
}
