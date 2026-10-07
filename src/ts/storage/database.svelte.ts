import { saveAsset as saveImageGlobal } from "../globalApi.svelte";
import { defaultAIN, defaultOoba, presetTemplate } from "../../../shared/presets.ts";
import { defaultSdData } from "../../../shared/characters.ts";

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
export let appVer = "2026.8.250"; //<APP_VERSION_POINT>
export let appSubVer = "";

export type * from "../../../shared/database.ts";
export { defaultAIN, defaultOoba, presetTemplate };
export type { DeepReadonly } from "../../../shared/readonly.ts";

export const saveImage = saveImageGlobal;

/** The default image-generation prompt table (`shared/characters.ts`; a fresh copy each call). */
export const defaultSdDataFunc = defaultSdData;
