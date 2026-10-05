import { findCharacter } from "../storage/characterStore.svelte";
import { chatList, findChat } from "../storage/chatStore.svelte";

type ChatBranch = {
    children: Map<string, ChatBranch>;
    maxChildren: number;
    /** The chat the branch was first seen in (its id; `""` for the root). */
    chatId: string;
};

function search(left: string[], branch: ChatBranch, chatId: string) {
    if (left.length === 0) {
        return;
    }

    const current = left[0];
    if (!branch.children.has(current)) {
        branch.children.set(current, {
            children: new Map(),
            maxChildren: 0,
            chatId: chatId,
        });
    }

    search(left.slice(1), branch.children.get(current)!, chatId);
}

function getMaxChildren(branch: ChatBranch) {
    let max = 0;
    if (branch.children.size === 0) {
        return 1;
    }

    for (const child of branch.children.values()) {
        max += getMaxChildren(child);
    }
    branch.maxChildren = max;
    return max;
}

type RenderedBranch = {
    x: number;
    y: number;
    connectX: number;
    connectY: number;
    content: string;
    multiChild: boolean;
    chatId: string;
};

function renderBranch(branch: ChatBranch, x: number, y: number, connectX = -1, connectY = -1): RenderedBranch[] {
    const rendered: RenderedBranch[] = [];
    for (const [key, child] of branch.children) {
        rendered.push({
            x,
            y,
            content: key,
            connectX,
            connectY,
            multiChild: branch.children.size > 1,
            chatId: child.chatId,
        });
        const childRendered = renderBranch(child, x, y + 1, x, y);
        rendered.push(...childRendered);
        x += child.maxChildren;
    }
    return rendered;
}

/**
 * The branch view of a character's chats (every chat's greeting and messages as a tree). Reads the
 * loaded chats synchronously: the caller pins the character's chats and awaits `loadChats` first.
 */
export function getChatBranches(chaId: string) {
    const character = findCharacter(chaId);

    const mainBranch: ChatBranch = {
        children: new Map(),
        maxChildren: 0,
        chatId: "",
    };
    if (!character) {
        return [];
    }

    for (const entry of chatList(chaId)) {
        const chat = findChat({ chaId, chatId: entry.id });
        if (!chat) {
            continue;
        }
        const fm = chat.fmIndex === -1 ? character.firstMessage : character.alternateGreetings?.[chat.fmIndex ?? 0];
        // const chatList = [fm].concat(chat.message.map((v) => v.data))
        const hashes: string[] = [simpleHasher(fm)];
        for (const message of chat.message) {
            hashes.push(simpleHasher(message.data));
        }

        search(hashes, mainBranch, entry.id);
    }

    getMaxChildren(mainBranch);

    return renderBranch(mainBranch, 0, 0);
}

function simpleHasher(str: string) {
    let hash = 0;
    if (str.length == 0) return "";
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
}
