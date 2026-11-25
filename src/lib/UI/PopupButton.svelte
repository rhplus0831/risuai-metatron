<script lang="ts">
    import { MenuIcon } from "@lucide/svelte";
    import { popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";

    /**
     * A menu button: a click puts its snippet and the pointer position in `popupStore`, which
     * `src/lib/UI/PopupList.svelte` renders; a click on the same button while its menu is open closes it.
     * It reads that open state before the zero-delay deferral, because PopupList's document click listener
     * clears the store first.
     */
    const {
        children,
    }: {
        children: import("svelte").Snippet;
    } = $props();

    let buttonId = Math.random();
</script>

<button
    onclick={async (e: MouseEvent) => {
        const wasOpen = popupStore.openId === buttonId && popupStore.children !== null;
        await sleep(0);
        if (wasOpen) {
            popupStore.children = null;
            popupStore.openId = 0;
            return;
        }
        popupStore.mouseX = e.clientX;
        popupStore.mouseY = e.clientY;
        popupStore.children = children;
        popupStore.openId = buttonId;
    }}
    class="hover:text-blue-500 transition-colors button-icon-menu"
>
    <MenuIcon size={20} />
</button>
