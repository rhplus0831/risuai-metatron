<script lang="ts">
    import { v4 } from "uuid";
    import { language } from "src/lang";
    import { alertConfirm, alertError } from "src/ts/alert";
    import { findCharacter, selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import {
        chatOwnerToken,
        currentChatRef,
        ensureChatLoaded,
        findChat,
        selectedChat,
        setChatMeta,
        type ChatRef,
    } from "src/ts/storage/chatStore.svelte";
    import { loreWriteFenced } from "src/ts/storage/chatFieldDraft.svelte";
    import { useLoreOverridesDraft } from "src/ts/storage/loreOverridesDraft.svelte";
    import { DetachedWrapperError } from "src/ts/storage/records.svelte";
    import type { Chat, ChatLoreOverride, loreBook } from "../../../../shared/database.ts";
    import type { DeepReadonly } from "../../../../shared/readonly.ts";
    import { mergeOwnerLore, offOverrideIds } from "../../../../shared/lore/overrides.ts";
    import LoreOverrideRow, { type EntryState, type FolderState } from "./LoreOverrideRow.svelte";

    const draft = useLoreOverridesDraft();
    // The section remounts for another chat; stale input events cannot edit its draft.
    const mountedRef = currentChatRef();
    const keyOf = (ref: ChatRef | null) => (ref ? `${ref.chaId}\u0000${ref.chatId}` : "");
    const mountedKey = keyOf(mountedRef);
    const ownerLore = () => selectedCharacter()?.globalLore ?? [];
    const goneEntry = (): loreBook => ({
        key: "",
        comment: "",
        content: "",
        mode: "normal",
        insertorder: 100,
        alwaysActive: false,
        secondkey: "",
        selective: false,
    });
    function holdsOriginal(book: loreBook) {
        try {
            return keyOf(currentChatRef()) === mountedKey && ownerLore().includes(book);
        } catch (error) {
            if (error instanceof DetachedWrapperError) return false;
            throw error;
        }
    }
    const liveOriginal = (book: loreBook) => (holdsOriginal(book) ? book : goneEntry());
    function liveOverride(target: ChatLoreOverride): ChatLoreOverride {
        return keyOf(currentChatRef()) === mountedKey && draft.key === mountedKey && draft.value.includes(target)
            ? target
            : { entry: { ...goneEntry(), id: "" }, off: false };
    }
    function replaceEntry(target: ChatLoreOverride, entry: loreBook) {
        liveOverride(target).entry = entry;
    }
    function overrideFor(book: loreBook): ChatLoreOverride | undefined {
        if (!holdsOriginal(book) || draft.key !== mountedKey || !book.id) return;
        if (ownerLore().find((entry) => entry.id === book.id) !== book) return;
        return draft.value.find((override) => override.entry.id === book.id);
    }

    const isGroupKey = (key: unknown): key is string => typeof key === "string" && key !== "";
    type Node = { book: loreBook; children: Node[] };
    // Show every owner entry once, including dangling folders and cycles. Owner order decides
    // override matching before this presentation grouping ever runs.
    const tree = $derived.by(() => {
        const lore = ownerLore();
        const shown = new Set<loreBook>();
        const expandedKeys = new Set<string>();
        function node(book: loreBook): Node {
            shown.add(book);
            const children: Node[] = [];
            // Only a non-empty string key groups entries, as in mergeOwnerLore: a keyless folder holds none.
            if (book.mode === "folder" && isGroupKey(book.key) && !expandedKeys.has(book.key)) {
                expandedKeys.add(book.key);
                for (const child of lore) {
                    if (!shown.has(child) && child.folder === book.key) children.push(node(child));
                }
            }
            return { book, children };
        }
        const roots: Node[] = [];
        for (const book of lore) {
            if (!book.folder && !shown.has(book)) roots.push(node(book));
        }
        for (const book of lore) {
            if (!shown.has(book)) roots.push(node(book));
        }
        return roots;
    });
    /**
     * The owner entries inside the folders with these keys, by the owner's current folder keys: an
     * entry whose `folder` equals a collected key is inside, and a folder inside adds its own key until
     * nothing changes (the key set ends cycles), the membership rule of `mergeOwnerLore`.
     */
    function membersOf(keys: unknown[]): Set<loreBook> {
        const lore = ownerLore();
        const seen = new Set<string>();
        const pending: string[] = [];
        const add = (key: unknown) => {
            if (isGroupKey(key) && !seen.has(key)) {
                seen.add(key);
                pending.push(key);
            }
        };
        keys.forEach(add);
        const members = new Set<loreBook>();
        while (pending.length > 0) {
            const key = pending.pop();
            for (const book of lore) {
                if (members.has(book) || book.folder !== key) continue;
                members.add(book);
                if (book.mode === "folder") add(book.key);
            }
        }
        return members;
    }
    // Entries and folders that an off folder drops from this chat's lore.
    const offMembers = $derived(
        membersOf(
            ownerLore()
                .filter((book) => book.mode === "folder" && overrideFor(book)?.off === true)
                .map((book) => book.key),
        ),
    );
    /** The overrides a folder's indicator counts: its entries' overrides and its nested folders that are off. */
    function changedIds(folder: loreBook): string[] {
        if (!holdsOriginal(folder)) return [];
        const own = overrideFor(folder)?.entry.id;
        const ids = new Set<string>();
        for (const book of membersOf([folder.key])) {
            if (book === folder) continue;
            const override = overrideFor(book);
            if (override && override.entry.id !== own && (book.mode !== "folder" || override.off)) {
                ids.add(override.entry.id);
            }
        }
        return [...ids];
    }
    const orphans = $derived(mergeOwnerLore(ownerLore(), selectedChat()?.loreOverrides ?? []).orphans);
    const offIds = $derived(offOverrideIds(ownerLore(), selectedChat()?.loreOverrides ?? []));
    function hasOffLink(override: ChatLoreOverride | undefined) {
        return (
            !!override &&
            offIds.has(override.entry.id) &&
            !!selectedChat()?.localLore?.some((entry) => entry.mode === "child" && entry.id === override.entry.id)
        );
    }
    function refuseFenced(ref: ChatRef) {
        if (!loreWriteFenced(ref)) return false;
        alertError(language.chatGenerating);
        return true;
    }
    const entryState = (override?: ChatLoreOverride): EntryState =>
        !override ? "original" : override.off ? "off" : "overridden";
    const folderState = (override?: ChatLoreOverride): FolderState => (override?.off ? "off" : "on");
    /** The mounted chat while it is still selected with its draft, and `book` is one of its owner's entries. */
    function writableRef(book: loreBook): ChatRef | undefined {
        const ref = currentChatRef();
        if (!ref || !selectedChat() || keyOf(ref) !== mountedKey || draft.key !== mountedKey) return;
        return holdsOriginal(book) ? ref : undefined;
    }
    function pin(book: loreBook, off: boolean) {
        const ref = writableRef(book);
        if (!ref || refuseFenced(ref) || overrideFor(book)) return;
        if (!book.id || ownerLore().some((entry) => entry !== book && entry.id === book.id)) book.id = v4();
        const entry = JSON.parse(JSON.stringify($state.snapshot(book))) as ChatLoreOverride["entry"];
        draft.value.push({ entry, off });
    }
    function setRowState(book: loreBook, next: EntryState | FolderState) {
        const ref = writableRef(book);
        if (!ref) return;
        const override = overrideFor(book);
        if (book.mode === "folder") {
            if (next === folderState(override) || (next !== "on" && next !== "off")) return;
            if (!override) {
                pin(book, true);
                return;
            }
            if (refuseFenced(ref)) return;
            if (next === "off") {
                // An on folder override can arrive through data; turning it off keeps that copy.
                liveOverride(override).off = true;
                return;
            }
            // A folder copy holds no edits: remove every override with its id, leaving members as they were.
            const id = override.entry.id;
            for (let i = draft.value.length - 1; i >= 0; i--) {
                if (draft.value[i].entry.id === id) draft.value.splice(i, 1);
            }
            return;
        }
        if (next === entryState(override) || next === "on") return;
        if (!override) {
            pin(book, next === "off");
        } else if (next === "original") {
            void release(ref, [override.entry.id], false);
        } else if (!refuseFenced(ref)) {
            // The copy and its edits stay; only the state changes.
            liveOverride(override).off = next === "off";
        }
    }
    function releaseAll(folder: loreBook) {
        const ref = writableRef(folder);
        const ids = ref ? changedIds(folder) : [];
        if (ref && ids.length) void release(ref, ids, true);
    }
    /** Whether releasing changes more than the state: a collected entry copy differs from its original. */
    function hasEdits(chaId: string, collected: DeepReadonly<ChatLoreOverride[]>) {
        const lore = findCharacter(chaId)?.globalLore ?? [];
        return collected.some((override) => {
            const original = lore.find((entry) => entry.id === override.entry.id);
            if (original?.mode === "folder") return false;
            return (
                !original ||
                JSON.stringify($state.snapshot(override.entry)) !== JSON.stringify($state.snapshot(original))
            );
        });
    }
    /**
     * Removes every override with one of `ids` from the captured chat, which may no longer be the
     * selected one. A single entry confirms only when its copy holds edits; a folder's bulk release
     * always confirms. Changed overrides after the dialog write nothing, so the user decides again.
     */
    async function release(ref: ChatRef, ids: string[], bulk: boolean) {
        const owner = chatOwnerToken(ref.chaId);
        const targets = new Set(ids);
        if (!targets.size || refuseFenced(ref)) return;
        const collect = (chat: DeepReadonly<Chat>) =>
            (chat.loreOverrides ?? []).filter((override) => targets.has(override.entry.id));
        // Synchronous, so nothing runs between these checks and the comparison and write that follow.
        function captured() {
            const chat = findChat(ref);
            return chat && chatOwnerToken(ref.chaId) === owner && !refuseFenced(ref) ? chat : undefined;
        }
        try {
            await ensureChatLoaded(ref);
            let chat = captured();
            if (!chat) return;
            const collected = collect(chat);
            if (!collected.length) return;
            if (bulk || hasEdits(ref.chaId, collected)) {
                const before = JSON.stringify($state.snapshot(collected));
                const count = new Set(collected.map((override) => override.entry.id)).size;
                const strings = language.chatLoreOverrides;
                if (!(await alertConfirm(bulk ? strings.releaseAllConfirm(count) : strings.releaseConfirm))) return;
                await ensureChatLoaded(ref);
                chat = captured();
                if (!chat || JSON.stringify($state.snapshot(collect(chat))) !== before) return;
            }
            const loreOverrides = (chat.loreOverrides ?? []).filter((override) => !targets.has(override.entry.id));
            setChatMeta(ref, { loreOverrides });
        } catch (error) {
            alertError(error);
        }
    }
    async function resolveOrphan(target: DeepReadonly<ChatLoreOverride>, move: boolean) {
        const ref = currentChatRef();
        const chat = selectedChat();
        if (!ref || !chat || keyOf(ref) !== mountedKey || !chat.loreOverrides?.includes(target) || (move && target.off))
            return;
        const owner = chatOwnerToken(ref.chaId);
        if (refuseFenced(ref)) return;
        try {
            if (
                !(await alertConfirm(
                    move ? language.chatLoreOverrides.moveConfirm : language.chatLoreOverrides.deleteConfirm,
                ))
            )
                return;
            await ensureChatLoaded(ref);
            const current = findChat(ref);
            if (!current || chatOwnerToken(ref.chaId) !== owner || refuseFenced(ref)) return;
            const overrides = current.loreOverrides ?? [];
            if (!overrides.includes(target)) return;
            const loreOverrides = overrides.filter((override) => override !== target);
            if (move) {
                const entry: loreBook = JSON.parse(JSON.stringify(target.entry));
                entry.id = v4();
                delete entry.folder;
                setChatMeta(ref, { localLore: [...(current.localLore ?? []), entry], loreOverrides });
            } else {
                setChatMeta(ref, { loreOverrides });
            }
        } catch (error) {
            alertError(error);
        }
    }
</script>

<div class="flex flex-col gap-2">
    <p class="text-xs text-textcolor2">{language.chatLoreOverrides.hint}</p>
    {#each orphans as orphan (orphan)}
        <div class="border border-darkborderc rounded-md p-2">
            <p class="text-textcolor2 text-xs">{language.chatLoreOverrides.originalDeleted}</p>
            <p class="text-textcolor break-words">
                {orphan.entry.comment || orphan.entry.key || language.chatLoreOverrides.unnamedEntry}
            </p>
            <div class="flex flex-wrap gap-2 mt-2">
                <button
                    class="rounded-md bg-darkbutton text-textcolor px-2 py-1 hover:bg-selected"
                    onclick={() => resolveOrphan(orphan, false)}>{language.chatLoreOverrides.delete}</button
                >
                {#if !orphan.off}
                    <button
                        class="rounded-md bg-darkbutton text-textcolor px-2 py-1 hover:bg-selected"
                        onclick={() => resolveOrphan(orphan, true)}>{language.chatLoreOverrides.move}</button
                    >
                {/if}
            </div>
        </div>
    {/each}
    {@render rows(tree)}
    {#if tree.length === 0 && orphans.length === 0}
        <p class="text-textcolor2">{language.chatLoreOverrides.empty}</p>
    {/if}
</div>

{#snippet rows(nodes: Node[])}
    {#each nodes as node (node.book)}
        {@const book = node.book}
        {@const folder = liveOriginal(book).mode === "folder"}
        {@const override = overrideFor(book)}
        <LoreOverrideRow
            original={() => liveOriginal(book)}
            {override}
            {liveOverride}
            {replaceEntry}
            rowState={folder ? folderState(override) : entryState(override)}
            setRowState={(next) => setRowState(book, next)}
            changed={folder ? changedIds(book).length : 0}
            notApplied={folder && (override?.off === true || offMembers.has(book))}
            inOffFolder={offMembers.has(book)}
            offNotice={hasOffLink(override)}
            releaseAll={() => releaseAll(book)}
        >
            {@render rows(node.children)}
        </LoreOverrideRow>
    {/each}
{/snippet}
