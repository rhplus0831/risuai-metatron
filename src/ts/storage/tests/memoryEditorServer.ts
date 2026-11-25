import type { ChatOp } from "../../../../shared/chats";
import {
    ackChatWork,
    captureChatBaseline,
    chatNoticeSeq,
    chatWorkBody,
    finishIdleChatRefresh,
    isChatBehind,
    seedChats,
    takeChatWork,
} from "../chatStore.svelte";
import { StoreBackedServer } from "./storeBackedServer";

/** Drive the mounted editor through a job write, the tab's batch, and its idle read. */
export async function saveOverUnseenMemory(
    ref: { chaId: string; chatId: string },
    jobFields: NonNullable<Extract<ChatOp, { op: "meta" }>["set"]>,
    edit: () => void,
) {
    const server = await StoreBackedServer.create({ lock: true });
    const { chaId: characterId, chatId } = ref;
    try {
        const data = captureChatBaseline(ref).chat;
        server.set("characters", characterId, { chaId: characterId });
        const initial = server.chatBatch([
            { characterId, chatId, baseRevision: null, ops: [{ op: "create", chat: data }] },
        ]);
        seedChats(
            initial.chats.map(({ revision }) => ({ characterId, id: chatId, revision: revision! })),
            initial.chatOrders,
        );
        const base = initial.chats[0].revision!;
        server.writeJobChatMeta(characterId, chatId, jobFields);
        edit();
        const work = takeChatWork(new Set());
        const receipt = server.chatBatch(chatWorkBody(work).chats.map((group) => JSON.parse(group)));
        ackChatWork(work, receipt.chats, receipt.chatOrders);
        const stored = server.chat(characterId, chatId)!;
        const reread = isChatBehind(ref) && finishIdleChatRefresh(stored, chatNoticeSeq(ref), base);
        return { stored: stored.data, reread };
    } finally {
        server.close();
    }
}
