import type { Options } from "html-to-image/lib/types";

// html-to-image's cache otherwise keys by the query-free URL, so a thumbnail would stand in for the original.
export const SCREENSHOT_CAPTURE_OPTIONS = { includeQueryParams: true } satisfies Options;
