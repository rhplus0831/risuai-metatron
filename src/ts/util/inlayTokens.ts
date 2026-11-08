/**
 * Matches double-brace inlay references, capturing their token kind and nonempty payload without
 * crossing line breaks. The exported regexp is shared and global: exec/test callers must manage lastIndex.
 */

/** Chat inlay tokens (inlay/inlayed/inlayeddata), replaced by `src/ts/process/memory/hypav3.ts` for summaries. */
export const inlayTokenRegex = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;
