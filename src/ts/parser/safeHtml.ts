import DOMPurify from "dompurify";

export { default as escapeHtml } from "lodash/escape";

/** The export policy also applies to translated HTML, without parsing it as Markdown again. */
export function sanitizeExportHtml(data: string, arg: { forbidTags?: string[] } = {}) {
    return DOMPurify.sanitize(data, {
        FORBID_TAGS: ["a", "style", ...(arg.forbidTags || [])],
        FORBID_ATTR: ["style", "href", "class"],
    });
}
