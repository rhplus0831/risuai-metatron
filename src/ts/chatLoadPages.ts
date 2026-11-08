/**
 * Client entrypoint for chat row-window limits and load-size normalization from
 * `shared/chatLoadPages.ts`. Both chat screens use the shared defaults and positive-integer
 * normalization; the row cap is independent of the configured load increments.
 */

export {
    CHAT_ROW_CAP,
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    getAdditionalChatLoadPages,
    getInitialChatLoadPages,
    normalizeChatLoadPages,
} from "../../shared/chatLoadPages.ts";
