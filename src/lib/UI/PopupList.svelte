<script lang="ts">
    import { popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import { onDestroy, onMount } from "svelte";

    /**
     * The fixed-position host of `popupStore`'s menu, mounted by `src/App.svelte` while the store holds one. It closes
     * on the next document click; its listener is added after a zero-delay timer, so the click that opened it does
     * not close it.
     */

    let styleString = $derived.by(() => {
        let styleString = "";
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const mouseX = popupStore.mouseX;
        const mouseY = popupStore.mouseY;

        if (mouseX < windowWidth / 2) {
            styleString += `left: ${mouseX}px;`;
        } else {
            styleString += `right: ${windowWidth - mouseX}px;`;
        }
        if (mouseY < windowHeight / 2) {
            styleString += `top: ${mouseY}px;`;
        } else {
            styleString += `bottom: ${windowHeight - mouseY}px;`;
        }
        return styleString;
    });

    const close = () => {
        popupStore.children = null;
    };

    onMount(async () => {
        await sleep(0);
        document.addEventListener("click", close);
    });

    onDestroy(() => {
        document.removeEventListener("click", close);
    });
</script>

{#if popupStore.children}
    <div
        class="bg-darkbg border-darkborderc border rounded-md p-4 gap-2 flex flex-col fixed z-50 items-start"
        style={styleString}
    >
        {@render popupStore.children()}
    </div>
{/if}
