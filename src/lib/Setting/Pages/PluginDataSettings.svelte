<script lang="ts">
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertError } from "src/ts/alert";
    import { SafeLocalStorage } from "src/ts/plugins/pluginSafeClass";
    import { removeOrphanPluginPermissionGrants } from "src/ts/plugins/apiV3/v3.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        assignLegacyPluginStorageItem,
        clearPluginStorage,
        clearSafeLocalPluginStorage,
        deleteOwnedPluginStorage,
        deleteOwnedPluginStorageItem,
        getOwnedPluginStorageValue,
        hasOwnedPluginStorageItem,
        getPluginCustomValue,
        getPluginStorageValue,
        getSafeLocalPluginValue,
        pluginStorageInventory,
        removePluginStorageItem,
        removeSafeLocalPluginValue,
        setPluginCustomValue,
        type PluginStorageInventoryEntry,
    } from "src/ts/storage/pluginStorageStore.svelte";

    /** Inventory is a snapshot on mount, refresh, and mutation; only the selected value is pretty-printed. */
    type NamespaceId = "custom" | "pluginStorage" | "ownedPluginStorage" | "safeLocalPluginStorage" | "device";
    type Namespace = { id: NamespaceId; owner?: string; entries: PluginStorageInventoryEntry[]; bytes: number };
    const deviceStorage = new SafeLocalStorage();
    let namespaces = $state.raw<Namespace[]>([]);
    let ownedInventory = $state.raw<Record<string, PluginStorageInventoryEntry[]>>({});
    let owner = $state<string | null>(null);
    let assignmentOwner = $state<string | null>(null);
    const installed = $derived(settings.plugins ?? []);
    const owners = $derived([...new Set([...installed.map((plugin) => plugin.name), ...Object.keys(ownedInventory)])]);
    const assignableOwners = $derived([
        ...new Set(installed.map((plugin) => plugin.name).filter((name) => !name.includes("\u0000"))),
    ]);
    const ownedEntries = $derived(owner !== null && Object.hasOwn(ownedInventory, owner) ? ownedInventory[owner] : []);
    const displayedNamespaces = $derived<Namespace[]>([
        {
            id: "ownedPluginStorage",
            owner: owner ?? undefined,
            entries: ownedEntries,
            bytes: ownedEntries.reduce((total, entry) => total + entry.bytes, 0),
        },
        ...namespaces,
    ]);
    let search = $state("");
    let selected = $state<{ namespace: NamespaceId; owner?: string; key: string; json: string } | null>(null);
    let busy = $state(false);
    let cleanedGrants = $state(false);

    const namespaceLabel = (id: NamespaceId, owner?: string) =>
        language.pluginDataNamespaces[id] + (owner === undefined ? "" : `: ${JSON.stringify(owner)}`);
    const formatBytes = (bytes: number) => language.pluginDataBytes.replace("{bytes}", bytes.toLocaleString());

    function refresh() {
        try {
            const server = pluginStorageInventory();
            ownedInventory = server.ownedPluginStorage;
            if (owner === null || !owners.includes(owner)) owner = owners[0] ?? null;
            if (assignmentOwner === null || !assignableOwners.includes(assignmentOwner))
                assignmentOwner = assignableOwners[0] ?? null;
            const encoder = new TextEncoder();
            const device = deviceStorage.keys().map((key) => ({
                key,
                bytes: encoder.encode(JSON.stringify(deviceStorage.getItem(key))).byteLength,
            }));
            const inventories: [NamespaceId, PluginStorageInventoryEntry[]][] = [
                ["custom", server.custom],
                ["pluginStorage", server.pluginStorage],
                ["safeLocalPluginStorage", server.safeLocalPluginStorage],
                ["device", device],
            ];
            namespaces = inventories.map(([id, entries]) => ({
                id,
                entries,
                bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
            }));
            selected = null;
        } catch (error) {
            alertError(language.pluginDataError.replace("{error}", String(error)));
        }
    }

    onMount(refresh);

    function viewJson(namespace: Namespace, key: string) {
        try {
            const value =
                namespace.id === "ownedPluginStorage" && namespace.owner !== undefined
                    ? hasOwnedPluginStorageItem(namespace.owner, key)
                        ? getOwnedPluginStorageValue(namespace.owner, key)
                        : null
                    : namespace.id === "custom"
                      ? getPluginCustomValue(key)
                      : namespace.id === "pluginStorage"
                        ? getPluginStorageValue(key)
                        : namespace.id === "safeLocalPluginStorage"
                          ? getSafeLocalPluginValue(key)
                          : deviceStorage.getItem(key);
            selected = { namespace: namespace.id, owner: namespace.owner, key, json: JSON.stringify(value, null, 2) };
        } catch (error) {
            alertError(language.pluginDataError.replace("{error}", String(error)));
        }
    }

    async function deleteData(namespace: Namespace, key?: string) {
        busy = true;
        try {
            const message =
                key === undefined
                    ? language.pluginDataDeleteNamespaceConfirm.replace(
                          "{namespace}",
                          namespaceLabel(namespace.id, namespace.owner),
                      )
                    : language.pluginDataDeleteKeyConfirm
                          .replace("{namespace}", namespaceLabel(namespace.id, namespace.owner))
                          .replace("{key}", key);
            if (!(await alertConfirm(message))) return;
            if (key === undefined) {
                switch (namespace.id) {
                    case "ownedPluginStorage":
                        if (namespace.owner !== undefined) deleteOwnedPluginStorage(namespace.owner);
                        break;
                    case "pluginStorage":
                        clearPluginStorage();
                        break;
                    case "safeLocalPluginStorage":
                        clearSafeLocalPluginStorage();
                        break;
                    case "custom":
                        for (const entry of namespace.entries) setPluginCustomValue(entry.key, undefined);
                        break;
                    case "device":
                        deviceStorage.clear();
                        break;
                }
            } else {
                switch (namespace.id) {
                    case "ownedPluginStorage":
                        if (namespace.owner !== undefined) deleteOwnedPluginStorageItem(namespace.owner, key);
                        break;
                    case "pluginStorage":
                        removePluginStorageItem(key);
                        break;
                    case "safeLocalPluginStorage":
                        removeSafeLocalPluginValue(key);
                        break;
                    case "custom":
                        setPluginCustomValue(key, undefined);
                        break;
                    case "device":
                        deviceStorage.removeItem(key);
                        break;
                }
            }
            refresh();
        } catch (error) {
            alertError(language.pluginDataError.replace("{error}", String(error)));
        } finally {
            busy = false;
        }
    }

    async function assignLegacyKey(key: string) {
        const target = assignmentOwner;
        if (target === null || !assignableOwners.includes(target)) return;
        busy = true;
        try {
            if (
                hasOwnedPluginStorageItem(target, key) &&
                !(await alertConfirm(
                    language.pluginDataAssignOverwriteConfirm.replace("{owner}", target).replace("{key}", key),
                ))
            )
                return;
            if (!assignableOwners.includes(target)) return;
            assignLegacyPluginStorageItem(target, key);
            owner = target;
            refresh();
        } catch (error) {
            alertError(language.pluginDataError.replace("{error}", String(error)));
        } finally {
            busy = false;
        }
    }

    async function removeOrphanGrants() {
        busy = true;
        cleanedGrants = false;
        try {
            if (!(await alertConfirm(language.pluginRemoveOrphanGrantsConfirm))) return;
            await removeOrphanPluginPermissionGrants();
            cleanedGrants = true;
        } catch (error) {
            alertError(language.pluginPermissionResetError.replace("{error}", String(error)));
        } finally {
            busy = false;
        }
    }
</script>

<div class="flex flex-col gap-4 text-textcolor">
    <h3 class="text-xl font-bold">{language.pluginData}</h3>
    <div class="flex flex-wrap items-center gap-2">
        <label class="grow">
            <span class="sr-only">{language.pluginDataSearch}</span>
            <input
                type="search"
                bind:value={search}
                placeholder={language.pluginDataSearch}
                class="w-full rounded border border-borderc bg-bgcolor p-2 text-textcolor"
            />
        </label>
        <button class="rounded bg-darkbutton p-2 disabled:opacity-50" disabled={busy} onclick={refresh}>
            {language.pluginDataRefresh}
        </button>
    </div>
    {#each displayedNamespaces as namespace (namespace.id)}
        {@const filtered = namespace.entries.filter((entry) => entry.key.toLowerCase().includes(search.toLowerCase()))}
        <section class="rounded border border-darkborderc p-3">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div>
                    <h4 class="font-bold">{namespaceLabel(namespace.id, namespace.owner)}</h4>
                    <p class="text-sm text-textcolor2">
                        {language.pluginDataKeyCount.replace("{count}", namespace.entries.length.toLocaleString())}
                        · {formatBytes(namespace.bytes)}
                    </p>
                </div>
                <button
                    class="rounded bg-darkbutton p-2 text-draculared disabled:opacity-50"
                    disabled={busy ||
                        (namespace.id === "ownedPluginStorage"
                            ? namespace.owner === undefined || !Object.hasOwn(ownedInventory, namespace.owner)
                            : namespace.entries.length === 0)}
                    onclick={() => deleteData(namespace)}>{language.pluginDataDeleteAll}</button
                >
            </div>
            {#if namespace.id === "ownedPluginStorage" && owners.length > 0}
                <label class="mb-3 flex flex-wrap items-center gap-2">
                    <span>{language.pluginDataOwner}</span>
                    <select
                        class="rounded border border-borderc bg-bgcolor p-2 text-textcolor"
                        bind:value={owner}
                        disabled={busy}
                        onchange={() => (selected = null)}
                    >
                        {#each owners as name (name)}
                            <option value={name}>{name}</option>
                        {/each}
                    </select>
                </label>
            {:else if namespace.id === "pluginStorage"}
                <p class="mb-3 text-sm text-textcolor2">{language.pluginDataLegacyDescription}</p>
                {#if assignableOwners.length > 0}
                    <label class="mb-3 flex flex-wrap items-center gap-2">
                        <span>{language.pluginDataAssignOwner}</span>
                        <select
                            class="rounded border border-borderc bg-bgcolor p-2 text-textcolor"
                            bind:value={assignmentOwner}
                            disabled={busy}
                        >
                            {#each assignableOwners as name (name)}
                                <option value={name}>{name}</option>
                            {/each}
                        </select>
                    </label>
                {/if}
            {/if}
            {#if filtered.length === 0}
                <p class="text-textcolor2">{language.pluginDataEmpty}</p>
            {:else}
                <ul class="flex flex-col gap-2">
                    {#each filtered as entry (entry.key)}
                        <li class="flex flex-wrap items-center gap-2 border-t border-darkborderc pt-2">
                            <code class="min-w-0 grow break-all">{JSON.stringify(entry.key)}</code>
                            <span class="text-sm text-textcolor2">{formatBytes(entry.bytes)}</span>
                            <button class="rounded bg-darkbutton p-2" onclick={() => viewJson(namespace, entry.key)}>
                                {language.pluginDataViewJson}
                            </button>
                            {#if namespace.id === "pluginStorage" && assignableOwners.length > 0}
                                <button
                                    class="rounded bg-darkbutton p-2 disabled:opacity-50"
                                    disabled={busy || assignmentOwner === null}
                                    onclick={() => assignLegacyKey(entry.key)}
                                >
                                    {language.pluginDataAssign}
                                </button>
                            {/if}
                            <button
                                class="rounded bg-darkbutton p-2 text-draculared disabled:opacity-50"
                                disabled={busy}
                                onclick={() => deleteData(namespace, entry.key)}>{language.pluginDataDelete}</button
                            >
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/each}
    {#if selected}
        <section class="rounded border border-darkborderc p-3">
            <div class="flex items-center justify-between gap-2 mb-2">
                <h4 class="font-bold break-all">
                    {namespaceLabel(selected.namespace, selected.owner)}: {JSON.stringify(selected.key)}
                </h4>
                <button class="rounded bg-darkbutton p-2" onclick={() => (selected = null)}
                    >{language.pluginDataCloseJson}</button
                >
            </div>
            <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-darkbg p-2">{selected.json}</pre>
        </section>
    {/if}
    <button
        class="self-start rounded bg-darkbutton p-2 disabled:opacity-50"
        disabled={busy}
        onclick={removeOrphanGrants}
    >
        {language.pluginRemoveOrphanGrants}
    </button>
    {#if cleanedGrants}
        <p role="status" class="text-textcolor2">{language.pluginOrphanGrantsRemoved}</p>
    {/if}
</div>
