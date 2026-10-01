/**
 * The server generation lock (Phase 5, PLAN.md Decision 4): the message a generation job writes is
 * owned by that job from its `begin` until its final write is applied or the job ends. The resource
 * store consults it (`MessageGuard`) inside every transaction that could rewrite or remove an owned
 * message, and refuses the write unless it carries the owner's job token. Tokens never leave the
 * process; a client-supplied generation id grants nothing. In memory only: a server restart clears
 * it, and the Phase 2 fence then closes on the next ordinary write.
 */

export type MessageOwner = { jobId: string; generationId: string; token: string };

/** The read side the resource store consults. */
export type MessageGuard = {
    /** The token of the job owning the message, or null. */
    holder(characterId: string, chatId: string, messageId: string): string | null;
    /** The tokens owning any message of the chat. */
    chatHolders(characterId: string, chatId: string): ReadonlySet<string>;
    /** The tokens owning any message of any chat of the character. */
    characterHolders(characterId: string): ReadonlySet<string>;
    /** Whether the token belongs to a job that has not ended. */
    isLive(token: string): boolean;
};

export type MessageRef = { characterId: string; chatId: string; messageId: string };

export type GenerationLock = ReturnType<typeof createGenerationLock>;

const keyOf = (ref: MessageRef) => `${ref.characterId}\u0000${ref.chatId}\u0000${ref.messageId}`;

export function createGenerationLock() {
    const owned = new Map<string, MessageOwner & MessageRef>();
    const live = new Set<string>();

    function holders(match: (entry: MessageRef) => boolean): Set<string> {
        const tokens = new Set<string>();
        for (const entry of owned.values()) {
            if (match(entry)) {
                tokens.add(entry.token);
            }
        }
        return tokens;
    }

    const lock = {
        holder(characterId: string, chatId: string, messageId: string): string | null {
            return owned.get(keyOf({ characterId, chatId, messageId }))?.token ?? null;
        },
        chatHolders(characterId: string, chatId: string): ReadonlySet<string> {
            return holders((entry) => entry.characterId === characterId && entry.chatId === chatId);
        },
        characterHolders(characterId: string): ReadonlySet<string> {
            return holders((entry) => entry.characterId === characterId);
        },
        isLive(token: string): boolean {
            return live.has(token);
        },

        /** Registers a job's token as live (at admission). */
        addToken(token: string) {
            live.add(token);
        },

        /**
         * Gives the message to `owner` (a later `begin` of the same job replaces the generation).
         * Returns the previous owner, for `restore` when the write fails. Throws when another job
         * owns it or the token is not live.
         */
        acquire(ref: MessageRef, owner: MessageOwner): MessageOwner | null {
            if (!live.has(owner.token)) {
                throw new Error("The job has ended");
            }
            const key = keyOf(ref);
            const current = owned.get(key);
            if (current && current.token !== owner.token) {
                throw new Error("Another generation job owns this message");
            }
            owned.set(key, { ...ref, ...owner });
            return current ? { jobId: current.jobId, generationId: current.generationId, token: current.token } : null;
        },

        /** Puts back what `acquire` replaced (the previous owner, or nobody). */
        restore(ref: MessageRef, previous: MessageOwner | null) {
            const key = keyOf(ref);
            if (previous) {
                owned.set(key, { ...ref, ...previous });
            } else {
                owned.delete(key);
            }
        },

        /** Releases the message if `token` owns it with `generationId` (a later generation keeps it). */
        release(ref: MessageRef, token: string, generationId: string) {
            const key = keyOf(ref);
            const current = owned.get(key);
            if (current?.token === token && current.generationId === generationId) {
                owned.delete(key);
            }
        },

        /** Ends a job: its token dies and every message it owns is released. */
        endJob(token: string) {
            live.delete(token);
            for (const [key, entry] of owned) {
                if (entry.token === token) {
                    owned.delete(key);
                }
            }
        },

        /** The messages a token owns, with their generation. */
        ownedBy(token: string): (MessageRef & { generationId: string })[] {
            return [...owned.values()]
                .filter((entry) => entry.token === token)
                .map(({ characterId, chatId, messageId, generationId }) => ({
                    characterId,
                    chatId,
                    messageId,
                    generationId,
                }));
        },

        /** The owner of a message, or null. */
        ownerOf(ref: MessageRef): MessageOwner | null {
            const entry = owned.get(keyOf(ref));
            return entry ? { jobId: entry.jobId, generationId: entry.generationId, token: entry.token } : null;
        },
    };
    return lock satisfies MessageGuard;
}
