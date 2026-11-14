import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";

/**
 * Apply prompt and Lua chat edits to a detached chat without mutating the input or op values.
 * Messages keep their ids and are addressed only by id. Missing targets do nothing; unsupported
 * ops are dropped with a warning. Store validation, revisions, and generation fences do not run.
 */
export function reduceChatOps(chat: Chat, ops: readonly ChatOp[]): Chat {
    let current = chat;
    const updateMessage = (id: string | undefined, update: (message: Message) => Message) => {
        if (id === undefined || !current.message.some((message) => message.chatId === id)) {
            return;
        }
        current = {
            ...current,
            message: current.message.map((message) => (message.chatId === id ? update(message) : message)),
        };
    };
    for (const op of ops) {
        switch (op.op) {
            case "setText":
                updateMessage(op.id, (message) => ({ ...message, data: op.text }));
                break;
            case "setMessage":
                updateMessage(op.message.chatId, (message) => {
                    const next = structuredClone(op.message);
                    delete next.translation;
                    if (Object.hasOwn(message, "translation")) {
                        next.translation = structuredClone(message.translation);
                    }
                    return next;
                });
                break;
            case "patchMessage":
                updateMessage(op.id, (message) => {
                    const next = { ...message };
                    for (const key of op.unset ?? []) {
                        delete next[key];
                    }
                    const {
                        chatId: _id,
                        translation: _translation,
                        ...set
                    } = structuredClone(op.set ?? {}) as Partial<Message>;
                    return { ...next, ...set };
                });
                break;
            case "meta": {
                let next = { ...current } as Chat & Record<string, unknown>;
                for (const key of op.unset ?? []) {
                    delete next[key];
                }
                next = { ...next, ...structuredClone(op.set ?? {}) };
                for (const key of new Set([...Object.keys(op.mergeUnset ?? {}), ...Object.keys(op.merge ?? {})])) {
                    const stored = next[key];
                    const entries = op.merge && Object.hasOwn(op.merge, key) ? op.merge[key] : undefined;
                    if (!isPlainObject(stored) && !entries) {
                        continue;
                    }
                    const map: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
                    for (const id of op.mergeUnset && Object.hasOwn(op.mergeUnset, key) ? op.mergeUnset[key] : []) {
                        delete map[id];
                    }
                    next = { ...next, [key]: { ...map, ...structuredClone(entries ?? {}) } };
                }
                current = next;
                break;
            }
            case "remove": {
                const ids = new Set(op.ids);
                current = { ...current, message: current.message.filter((message) => !ids.has(message.chatId!)) };
                break;
            }
            case "append": {
                let position: number;
                if ("start" in op.anchor) {
                    position = 0;
                } else if ("end" in op.anchor) {
                    position = current.message.length;
                } else {
                    const after = op.anchor.after;
                    const index = current.message.findIndex((message) => message.chatId === after);
                    if (index === -1) {
                        break;
                    }
                    position = index + 1;
                }
                current = {
                    ...current,
                    message: [
                        ...current.message.slice(0, position),
                        ...structuredClone(op.messages),
                        ...current.message.slice(position),
                    ],
                };
                break;
            }
            case "replace":
                current = { ...structuredClone(op.chat), id: current.id };
                break;
            default:
                console.warn(`[Job] Unsupported detached chat operation: ${op.op}`);
        }
    }
    return current;
}
