/**
 * The client state of the `llmSecrets` record's `presets` map: each preset's `proxyKey`, by preset
 * id. It is not a `Database` field (the flat credential fields of the record mirror into
 * `DBState.db` like any section). The save adapter assembles it at boot, saves it with the
 * `llmSecrets` record, and replaces it on a conflict reload. Nothing reads it before the `proxyKey`
 * accessor of the forwarding layer (Phase 3, slice 5).
 */
export type PresetSecret = { proxyKey: string };

export const llmSecretPresets: { value: Record<string, PresetSecret> } = $state({ value: {} });

export function getPresetSecret(id: string): PresetSecret | undefined {
    return Object.hasOwn(llmSecretPresets.value, id) ? llmSecretPresets.value[id] : undefined;
}

export function setPresetSecret(id: string, entry: PresetSecret) {
    const next = { proxyKey: entry.proxyKey };
    if (id === "__proto__") {
        // An assignment through the proxy cannot create an own `__proto__` key; rebuild the map.
        const entries = Object.entries(llmSecretPresets.value).filter(([key]) => key !== id);
        llmSecretPresets.value = Object.fromEntries([...entries, [id, next]]);
        return;
    }
    llmSecretPresets.value[id] = next;
}

export function deletePresetSecret(id: string) {
    delete llmSecretPresets.value[id];
}

/** Gives preset `to` a copy of preset `from`'s entry, or none when `from` has none. */
export function copyPresetSecret(from: string, to: string) {
    const entry = getPresetSecret(from);
    if (entry) {
        setPresetSecret(to, entry);
    } else {
        deletePresetSecret(to);
    }
}

/** Replaces the whole map (boot and conflict reload), keeping only well-formed entries. */
export function replacePresetSecrets(presets: unknown) {
    const next: [string, PresetSecret][] = [];
    if (presets && typeof presets === "object" && !Array.isArray(presets)) {
        for (const [id, entry] of Object.entries(presets)) {
            if (entry && typeof entry === "object" && typeof (entry as PresetSecret).proxyKey === "string") {
                next.push([id, { proxyKey: (entry as PresetSecret).proxyKey }]);
            }
        }
    }
    llmSecretPresets.value = Object.fromEntries(next);
}
