<script lang="ts">
    import { v4 } from "uuid";
    import { language } from "src/lang";
    import { alertConfirm, alertError } from "src/ts/alert";
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
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
    import type { ChatLoreOverride, loreBook } from "../../../../shared/database.ts";
    import type { DeepReadonly } from "../../../../shared/readonly.ts";
    import { mergeOwnerLore, offOverrideIds } from "../../../../shared/lore/overrides.ts";
    import LoreOverrideRow from "./LoreOverrideRow.svelte";

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
            if (book.mode === "folder" && !expandedKeys.has(book.key)) {
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
    function descendants(folder: loreBook): loreBook[] {
        if (!holdsOriginal(folder)) return [];
        const lore = ownerLore();
        const keys = new Set<string>();
        const entries = new Set<loreBook>();
        function visit(key: string) {
            if (keys.has(key)) return;
            keys.add(key);
            for (const book of lore) {
                if (book.folder !== key) continue;
                if (book.mode === "folder") visit(book.key);
                else entries.add(book);
            }
        }
        visit(folder.key);
        return [...entries];
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
    function pin(entries: loreBook[]) {
        const ref = currentChatRef();
        if (!ref || !selectedChat() || keyOf(ref) !== mountedKey || draft.key !== mountedKey) return;
        if (refuseFenced(ref)) return;
        for (const book of entries) {
            if (!holdsOriginal(book) || book.mode === "folder" || overrideFor(book)) continue;
            if (!book.id || ownerLore().some((entry) => entry !== book && entry.id === book.id)) book.id = v4();
            const entry = JSON.parse(JSON.stringify($state.snapshot(book))) as ChatLoreOverride["entry"];
            draft.value.push({ entry, off: false });
        }
    }
    async function release(entries: loreBook[]) {
        const ref = currentChatRef();
        if (!ref || !selectedChat() || keyOf(ref) !== mountedKey) return;
        const owner = chatOwnerToken(ref.chaId);
        const ids = new Set(
            entries
                .map(overrideFor)
                .filter((value) => !!value)
                .map((value) => value.entry.id),
        );
        if (!ids.size || refuseFenced(ref)) return;
        try {
            if (!(await alertConfirm(language.chatLoreOverrides.releaseConfirm))) return;
            await ensureChatLoaded(ref);
            const chat = findChat(ref);
            if (!chat || chatOwnerToken(ref.chaId) !== owner || refuseFenced(ref)) return;
            // Remove only the first override per captured id, as in mergeOwnerLore.
            const remaining = new Set(ids);
            const loreOverrides = (chat.loreOverrides ?? []).filter((override) => !remaining.delete(override.entry.id));
            if (remaining.size === ids.size) return;
            setChatMeta(ref, { loreOverrides });
        } catch (error) {
            alertError(error);
        }
    }
    function toggle(book: loreBook, checked: boolean) {
        if (!holdsOriginal(book)) return;
        const entries = book.mode === "folder" ? descendants(book) : [book];
        if (checked) pin(entries);
        else void release(entries);
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
        {@const entries = liveOriginal(book).mode === "folder" ? descendants(book) : []}
        {@const pinned = entries.filter((entry) => !!overrideFor(entry)).length}
        {@const override = overrideFor(book)}
        <LoreOverrideRow
            original={() => liveOriginal(book)}
            {override}
            {liveOverride}
            {replaceEntry}
            toggle={(checked) => toggle(book, checked)}
            all={entries.length > 0 && pinned === entries.length}
            some={pinned > 0}
            offNotice={hasOffLink(override)}
        >
            {@render rows(node.children)}
        </LoreOverrideRow>
    {/each}
{/snippet}
