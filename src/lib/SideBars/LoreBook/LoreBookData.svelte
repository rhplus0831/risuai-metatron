<script lang="ts">
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { useLocalLoreDraft } from "src/ts/storage/localLoreDraft.svelte";
    import { XIcon, LinkIcon, SunIcon, BookCopyIcon, FolderIcon, FolderOpen, PlusIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { language } from "../../../lang";
    import { type loreBook } from "../../../ts/storage/database.svelte";
    import {
        chatOwnerToken,
        currentChatRef,
        ensureChatLoaded,
        selectedChat,
        setChatMeta,
    } from "../../../ts/storage/chatStore.svelte";
    import { loreWriteFenced } from "src/ts/storage/chatFieldDraft.svelte";
    import { alertConfirm, alertError, alertMd } from "../../../ts/alert";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import { offOverrideIds } from "../../../../shared/lore/overrides.ts";
    import LoreEntryFields from "./LoreEntryFields.svelte";
    import LoreBookList from "./LoreBookList.svelte";

    /**
     * One lorebook row (an entry, a folder with its nested list, or a chat's `child` link) and its open body.
     * `activateLocally` adds a live `mode: "child"` link to the chat's local lore draft, independent of the chat's
     * frozen overrides; the checkbox shows, and unchecking removes, only `mode: "child"` links with the entry's id, so
     * a plain chat entry that kept the same id (an import) is neither shown as linked nor deleted. Off wins over a
     * local activation: an off override (`offOverrideIds`, `shared/lore/overrides.ts`) shows its notice under the
     * checkbox and on a `child` row. The checkbox is disabled, and a change refused before any write (the entry's id
     * included), while a send or job runs in the selected chat (`loreWriteFenced`).
     *
     * `locked` (the row belongs to a chat's lore under that fence) disables every write control of the row and its
     * folder list, and opening the row writes nothing.
     *
     * Delete captures the entry's id, a folder's member ids (`folder === key`), whether it is in the selected
     * character's `globalLore`, the chat ref, and the owner token before either dialog. A character entry whose ids
     * the captured chat links (`child`) is not removed while that chat is fenced: the click is refused before the
     * dialogs when the selected chat shows such a link, and again after them, once `ensureChatLoaded` has the chat
     * and the owner token still matches; otherwise `onRemove` and the removal of the matching links in one
     * `setChatMeta` run together. A chat that fails to load, or a replaced owner, removes only the entry. A chat-local
     * row (a child link or a nested folder member included) is removed only through its list's draft, with no
     * separate id cascade.
     */

    interface Props {
        value: loreBook;
        onRemove?: () => boolean | void;
        onClose?: (isDetail?: boolean) => void;
        onOpen?: (isDetail?: boolean) => void;
        onFolderActive?: (active: boolean) => void;
        lorePlus?: boolean;
        idx: number;
        externalLoreBooks?: loreBook[];
        idgroup: string;
        isOpen?: boolean;
        /** The list's filter shows this folder expanded: shown open, its toggle does nothing. */
        forceOpen?: boolean;
        /** The list's filter hides this row (it stays mounted, keeping its state). */
        hidden?: boolean;
        openFolders?: number;
        isLastInContainer?: boolean;
        /** The row belongs to a chat's lore while a send or job runs in it: its write controls are disabled. */
        locked?: boolean;
    }

    let {
        value = $bindable(),
        onRemove = () => {},
        onClose = (isDetail = true) => {},
        onOpen = (isDetail = true) => {},
        onFolderActive = (active) => {},
        lorePlus = false,
        idx,
        externalLoreBooks = $bindable(),
        idgroup,
        isOpen = false,
        forceOpen = false,
        hidden = false,
        openFolders = 0,
        isLastInContainer = false,
        locked = false,
    }: Props = $props();

    let open = $derived(isOpen);
    const shownOpen = $derived(open || forceOpen);

    const offIds = $derived(offOverrideIds(selectedCharacter()?.globalLore ?? [], selectedChat()?.loreOverrides ?? []));
    // The selected chat's lore is fenced: the local activation checkbox writes it from any tab.
    const chatFenced = $derived.by(() => {
        const ref = currentChatRef();
        return ref !== null && loreWriteFenced(ref);
    });

    function isLocallyActivated(book: loreBook) {
        return book.id ? selectedChat()?.localLore.some((e) => e.mode === "child" && e.id === book.id) : false;
    }
    function activateLocally(book: loreBook) {
        if (!book.id) {
            book.id = v4();
        }

        const childLore: loreBook = {
            key: "",
            comment: "",
            content: "",
            mode: "child",
            insertorder: 100,
            alwaysActive: true,
            secondkey: "",
            selective: false,
            id: book.id,
        };
        useLocalLoreDraft().value.push(childLore);
    }
    function deactivateLocally(book: loreBook) {
        if (!book.id) return;
        const draft = useLocalLoreDraft();
        if (draft.value.some((e) => e.mode === "child" && e.id === book.id)) {
            draft.value = draft.value.filter((e) => e.mode !== "child" || e.id !== book.id);
        }
    }
    function toggleLocalActive(check: boolean, book: loreBook) {
        const ref = currentChatRef();
        if (ref && loreWriteFenced(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        if (check) {
            activateLocally(book);
        } else {
            deactivateLocally(book);
        }
    }
    function getParentLoreName(book: loreBook) {
        if (book.mode === "child") {
            const value = selectedCharacter()?.globalLore.find((e) => e.id === book.id);
            if (value) {
                return value.comment.length === 0
                    ? value.key.length === 0
                        ? "Unnamed Lore"
                        : value.key
                    : value.comment;
            }
        }
    }
</script>

<div
    class={"w-full flex flex-col " +
        (isLastInContainer
            ? "pb-0 mb-0 border-0" // Last item in container: no border
            : "pb-2 mb-2 border-b border-b-selected last:pb-0 last:mb-0 last:border-0")}
    class:no-sort={value.mode === "folder" && openFolders > 0}
    class:hidden
    data-risu-idx={idx}
    data-risu-idgroup={idgroup}
>
    <div class="flex items-center transition-colors w-full p-1">
        {#if value.mode !== "child"}
            <button
                class="endflex valuer border-darkborderc flex items-center"
                onclick={() => {
                    if (forceOpen) return;
                    if (!locked) value.secondkey = value.secondkey ?? "";
                    if (!open) {
                        open = true;
                        onOpen(value.mode !== "folder"); // If not a folder, pass true
                    } else {
                        open = false;
                        onClose(value.mode !== "folder"); // If not a folder, pass true
                    }
                }}
            >
                {#if value.mode === "folder"}
                    {#if shownOpen}
                        <FolderOpen size={20} class="mr-1" />
                    {:else}
                        <FolderIcon size={20} class="mr-1" />
                    {/if}
                {/if}
                {#if value.mode === "folder"}
                    <span>{value.comment.length === 0 ? "Unnamed Folder" : value.comment}</span>
                {:else}
                    <span
                        >{value.comment.length === 0
                            ? value.key.length === 0
                                ? "Unnamed Lore"
                                : value.key
                            : value.comment}</span
                    >
                {/if}
            </button>
            <button
                class="mr-1 disabled:opacity-50 disabled:cursor-not-allowed"
                class:text-textcolor2={!value.alwaysActive}
                class:text-textcolor={value.alwaysActive}
                disabled={locked}
                onclick={async () => {
                    if (locked) return;
                    if (value.mode === "folder") {
                        onFolderActive(!value.alwaysActive);
                    }
                    value.alwaysActive = !value.alwaysActive;
                }}
            >
                {#if value.alwaysActive}
                    <SunIcon size={20} />
                {:else}
                    <LinkIcon size={20} />
                {/if}
            </button>
            <button
                class="valuer"
                disabled={locked}
                onclick={async () => {
                    if (locked) return;
                    // Keep only the entry's primitives and the chat address across the dialogs.
                    const members =
                        value.mode === "folder"
                            ? (externalLoreBooks ?? []).filter((entry) => entry.folder === value.key)
                            : [];
                    const removedIds = new Set(
                        [value, ...members].map((entry) => entry.id).filter((id): id is string => !!id),
                    );
                    const isCharacterEntry = !!selectedCharacter()?.globalLore.includes(value);
                    const chatTarget = currentChatRef();
                    const chatOwner = chatTarget ? chatOwnerToken(chatTarget.chaId) : null;
                    const removeMessage = language.removeConfirm + (value.comment || "Unnamed Folder");
                    const isRemovedChild = (entry: Pick<loreBook, "id" | "mode">) =>
                        entry.mode === "child" && !!entry.id && removedIds.has(entry.id);
                    const cascades = isCharacterEntry && removedIds.size > 0;
                    if (
                        cascades &&
                        chatTarget &&
                        loreWriteFenced(chatTarget) &&
                        (selectedChat()?.localLore ?? []).some(isRemovedChild)
                    ) {
                        alertError(language.chatGenerating);
                        return;
                    }
                    if (members.length > 0) {
                        if (!(await alertConfirm(language.folderRemoveConfirm))) return;
                    }
                    if (!(await alertConfirm(removeMessage))) return;
                    if (!cascades || !chatTarget) {
                        onRemove();
                        return;
                    }

                    let chat: Awaited<ReturnType<typeof ensureChatLoaded>>;
                    try {
                        // The captured chat may have been evicted while a dialog was open.
                        chat = await ensureChatLoaded(chatTarget);
                    } catch (error) {
                        onRemove();
                        alertError(error);
                        return;
                    }
                    const localLore =
                        chat && chatOwnerToken(chatTarget.chaId) === chatOwner ? (chat.localLore ?? []) : [];
                    const linked = localLore.some(isRemovedChild);
                    // Refused before the entry goes: removing it alone would leave the chat's links behind.
                    if (linked && loreWriteFenced(chatTarget)) {
                        alertError(language.chatGenerating);
                        return;
                    }
                    if (!onRemove() || !linked) return;
                    try {
                        setChatMeta(chatTarget, { localLore: localLore.filter((entry) => !isRemovedChild(entry)) });
                    } catch (error) {
                        alertError(error);
                    }
                }}
            >
                <XIcon size={20} />
            </button>
        {:else}
            <button class="endflex valuer border-darkborderc" onclick={() => alertMd(language.childLoreDesc)}>
                <BookCopyIcon size={20} class="mr-1" />
                <span>{getParentLoreName(value)}</span>
            </button>
            <button
                class="valuer"
                disabled={locked}
                onclick={async () => {
                    if (locked) return;
                    const d = await alertConfirm(language.removeConfirm + getParentLoreName(value));
                    if (d) {
                        onRemove();
                    }
                }}
            >
                <XIcon size={20} />
            </button>
        {/if}
    </div>
    {#if value.mode === "child" && offIds.has(value.id)}
        <p class="text-xs text-textcolor2 mt-1">{language.chatLoreOverrides.linkOffNotice}</p>
    {/if}
    {#if shownOpen}
        {#if value.mode === "folder"}
            <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2">
                <span class="text-textcolor mt-6 mb-2">{language.folderName}</span>
                <TextInput size="sm" disabled={locked} bind:value={value.comment} />

                <div class="mt-4">
                    <LoreBookList
                        {externalLoreBooks}
                        {locked}
                        showFolder={value.key}
                        onMemberOpen={() => {
                            if (open) return;
                            open = true;
                            onOpen(false);
                        }}
                    />
                </div>

                <div class="mt-2 flex gap-1">
                    <button
                        class="text-textcolor2 hover:text-textcolor disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={locked}
                        onclick={() => {
                            if (locked) return;
                            externalLoreBooks.push({
                                key: "",
                                comment: "",
                                content: "",
                                mode: "normal",
                                insertorder: 100,
                                alwaysActive: true,
                                secondkey: "",
                                selective: false,
                                folder: value.key,
                            });
                        }}
                    >
                        <PlusIcon size={20} />
                    </button>
                </div>
            </div>
        {:else}
            <LoreEntryFields bind:value {lorePlus} disabled={locked}>
                {#snippet localActivation()}
                    {#if !value.alwaysActive && selectedCharacter()?.globalLore?.includes(value) && settings.ui.localActivationInGlobalLorebook}
                        <div class="flex items-center mt-2">
                            <Check
                                disabled={chatFenced}
                                check={isLocallyActivated(value)}
                                onChange={(check: boolean) => toggleLocalActive(check, value)}
                                name={language.alwaysActiveInChat}
                            />
                        </div>
                        {#if offIds.has(value.id)}
                            <p class="text-xs text-textcolor2 mt-1">{language.chatLoreOverrides.linkOffNotice}</p>
                        {/if}
                    {/if}
                {/snippet}
            </LoreEntryFields>
        {/if}
    {/if}
</div>

<style>
    .valuer:hover:not(:disabled) {
        color: rgba(16, 185, 129, 1);
        cursor: pointer;
    }

    .valuer:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    .endflex {
        display: flex;
        flex-grow: 1;
        cursor: pointer;
    }

    /* Styles for SortableJS drag-and-drop feedback */
    :global(.risu-chosen-item) {
        /* The item being dragged */
        padding-bottom: 0.5rem;
        margin-bottom: 0.5rem;
        border-bottom: 1px solid;
        border-bottom-color: var(--risu-theme-selected);
        opacity: 0.7;
    }

    :global(.risu-ghost-item) {
        /* The placeholder for the drop location */
        background-color: rgba(var(--risu-theme-selected-rgb), 0.2);
    }
</style>
