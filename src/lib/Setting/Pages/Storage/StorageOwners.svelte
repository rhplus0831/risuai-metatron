<script lang="ts">
    import { language } from "src/lang";
    import { getStorageController } from "./storageContext";

    const controller = getStorageController();
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    {#if controller.report}
        <p class="text-textcolor2">{language.storage.sharesNote}</p>
        <div class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
            <table class="w-full table-fixed text-left">
                <thead
                    ><tr>
                        <th class="p-2">{language.storage.ownerKind}</th>
                        <th class="p-2">{language.storage.name}</th>
                        <th class="p-2">{language.storage.count}</th>
                        <th class="p-2">{language.storage.bytes}</th>
                    </tr></thead
                >
                <tbody>
                    {#each controller.owners as owner}
                        <tr class="border-t border-darkborderc">
                            <td class="p-2 break-all">{language.storage.ownerKinds[owner.kind]}</td>
                            <td class="p-2 break-all">{owner.name}</td>
                            <td class="p-2 break-all">{owner.count.toLocaleString()}</td>
                            <td class="p-2 break-all">{controller.formatBytes(owner.bytes)}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
</div>
