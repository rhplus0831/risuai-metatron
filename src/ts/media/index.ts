/**
 * Media entry point: `compressImage` serves card export in `src/ts/characterCards.ts`
 * and module export in `src/ts/process/modules.ts`; `getImageType` serves card import
 * in `src/ts/characters.ts`, card assets in `src/ts/characterCards.ts`, and inlay images
 * in `src/ts/process/files/inlays.ts`.
 */

export { compressImage } from "./compressImage";
export { getImageType } from "./imageType";
