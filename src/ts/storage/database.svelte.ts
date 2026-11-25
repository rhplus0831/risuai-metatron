import { saveAsset as saveImageGlobal } from "../globalApi.svelte";
import { defaultAIN, defaultOoba, presetTemplate } from "../../../shared/presets.ts";
import { defaultSdData } from "../../../shared/characters.ts";

/**
 * Client compatibility entrypoint for the flat `Database` types in `shared/database.ts`, shared
 * preset defaults, version strings, and asset saving. These types describe legacy snapshots and
 * persisted formats; this module holds no live database instance.
 *
 * `src/ts/storage/snapshots.svelte.ts` builds detached copies for plugins, reports, and backup
 * inventories. Editing those copies does not write to the stores. Live settings are served by
 * `src/ts/storage/settingsViews.svelte.ts` over the write-through records in
 * `src/ts/storage/records.svelte.ts`; validated external settings and collection writes go through
 * `src/ts/storage/collectionStore.svelte.ts`. Structural character writes go through
 * `src/ts/storage/characterStore.svelte.ts`, while chats and messages belong to
 * `src/ts/storage/chatStore.svelte.ts`, outside the character records.
 *
 * Selection belongs to `src/ts/storage/selection.svelte.ts`, not a shared settings record.
 * Write-only LLM credentials use `src/ts/storage/llmSecrets.svelte.ts`; settings snapshots expose
 * blank credential fields and readable siblings rather than secret values. Record and chat writes
 * are saved by `src/ts/storage/resourceSync.svelte.ts`.
 */

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
/** The upstream compatibility version, also used to invalidate the boot cache; keep it aligned with `version.json`. */
export let appVer = "2026.10.295"; //<APP_VERSION_POINT>
/** Optional suffix appended to `appVer` by `src/ts/globalApi.svelte.ts`'s `getVersionString`. */
export let appSubVer = "";

export type * from "../../../shared/database.ts";
export { defaultAIN, defaultOoba, presetTemplate };
export type { DeepReadonly } from "../../../shared/readonly.ts";

/** Alias of `src/ts/globalApi.svelte.ts`'s `saveAsset`, returning the saved asset key. */
export const saveImage = saveImageGlobal;

/** The default image-generation prompt table (`shared/characters.ts`; a fresh copy each call). */
export const defaultSdDataFunc = defaultSdData;
