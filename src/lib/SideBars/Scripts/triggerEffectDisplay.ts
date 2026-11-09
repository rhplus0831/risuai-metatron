/**
 * Formats effect summaries using trusted language markup, escaped stored values, and numeric indentation.
 * Drag preview text strips tags and decodes the five escaped entities for use with textContent.
 */
import { language } from "src/lang";
import type { triggerEffect, triggerEffectV2 } from "../../../../shared/triggers.ts";

function escapeDisplayValue(value: any) {
    if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function formatEffectDisplay(effect: triggerEffect, supported: boolean): string {
    const type = effect.type;

    if (!supported) {
        return `<span class="text-red-500">${language.triggerDesc.v2UnsupportedTriggerDesc}</span>`;
    }

    const indent = Number((effect as triggerEffectV2).indent) || 0;
    const txt = ((language.triggerDesc[type + "Desc"] as string) || escapeDisplayValue(type)).replace(
        /{{(.+?)}}/g,
        (match, p1) => {
            const d = escapeDisplayValue(effect[p1]);

            if (type === "v2Comment" && p1 === "value") {
                return `<span class="text-gray-400">${d || ""}</span>`;
            }

            if (typeof d === "boolean") {
                return `<span class="text-blue-500">${d ? "true" : "false"}</span>`;
            }

            if (p1.endsWith("Type")) {
                return `<span class="text-blue-500">${d || "null"}</span>`;
            }
            if (p1 === "condition" || p1 === "operator") {
                return `<span class="text-green-500">${d || "null"}</span>`;
            }
            if (effect[p1 + "Type"] === "var") {
                return `<span class="text-yellow-500">${d || "null"}</span>`;
            }
            if (effect[p1 + "Type"] === "value") {
                return `<span class="text-green-500">"${d}"</span>`;
            }
            if (effect.type === "v2If" && p1 === "source") {
                return `<span class="text-yellow-500">${d || "null"}</span>`;
            }
            if (effect.type === "v2SetVar" && p1 === "var") {
                return `<span class="text-yellow-500">${d || "null"}</span>`;
            }
            if (effect.type === "v2DeclareLocalVar" && p1 === "var") {
                return `<span class="text-cyan-500">${d || "null"}</span>`;
            }
            return `<span class="text-blue-500">${d || "null"}</span>`;
        },
    );

    if (type === "v2Comment") {
        return `<div class="text-gray-500 italic line-clamp-4" style="margin-left:${indent}rem; word-break: break-all; overflow-wrap: break-word;">// ${txt}</div>`;
    }

    return `<div class="text-purple-500 line-clamp-4" style="margin-left:${indent}rem; word-break: break-all; overflow-wrap: break-word;">${txt}</div>`;
}

export function effectDisplayText(html: string): string {
    return html
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}
