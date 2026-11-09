import { describe, expect, it } from "vitest";
import { language } from "src/lang";
import type { triggerEffect } from "../../../../shared/triggers.ts";
import { effectDisplayText, formatEffectDisplay } from "./triggerEffectDisplay";

function parseSummary(html: string) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
}

describe("formatEffectDisplay", () => {
    it("renders stored markup and ampersands as literal text", () => {
        const value = `<img src=x onerror=alert(1)> &lt;b&gt; & "double" 'single'`;
        // Imported fields can contain values outside their declared unions.
        const effect = {
            type: "v2SetVar",
            var: value,
            operator: value,
            value,
            valueType: "value",
            indent: 2,
        } as unknown as triggerEffect;

        const html = formatEffectDisplay(effect, true);
        const summary = parseSummary(html);

        expect(summary.querySelector("img")).toBeNull();
        expect(summary.textContent).toBe(`Set Variable ${value} ${value} "${value}"`);
        expect(html).toContain(
            "&lt;img src=x onerror=alert(1)&gt; &amp;lt;b&amp;gt; &amp; &quot;double&quot; &#39;single&#39;",
        );
    });

    it("escapes quotes in value-type fields and fallback effect names without creating attributes or elements", () => {
        const value = `"'></span><img src=x onerror='alert(1)' data-injected="yes">`;
        const effect = {
            type: "v2ExtractRegex",
            value: "input",
            valueType: "value",
            regex: "pattern",
            regexType: value,
            flags: "g",
            flagsType: "value",
            result: "$1",
            resultType: "value",
            outputVar: "result",
            indent: 0,
        } as unknown as triggerEffect;
        const html = formatEffectDisplay(effect, true);
        const summary = parseSummary(html);
        const fallbackHtml = formatEffectDisplay({ type: value, indent: 0 } as unknown as triggerEffect, true);
        const fallback = parseSummary(fallbackHtml);

        expect(summary.querySelector("img, [onerror], [data-injected]")).toBeNull();
        expect(summary.querySelectorAll("span")[1].textContent).toBe(value);
        expect(html).toContain(
            "&quot;&#39;&gt;&lt;/span&gt;&lt;img src=x onerror=&#39;alert(1)&#39; data-injected=&quot;yes&quot;&gt;",
        );
        expect(fallback.querySelector("img, [onerror], [data-injected]")).toBeNull();
        expect(fallback.querySelectorAll("*")).toHaveLength(1);
        expect(fallback.textContent).toBe(value);
        expect(fallbackHtml).toContain(
            "&quot;&#39;&gt;&lt;/span&gt;&lt;img src=x onerror=&#39;alert(1)&#39; data-injected=&quot;yes&quot;&gt;",
        );
    });

    it("uses zero indentation for a non-numeric stored indent", () => {
        const effect = { type: "v2Comment", value: "Note", indent: "not-a-number" } as unknown as triggerEffect;
        const summary = parseSummary(formatEffectDisplay(effect, true));

        expect(summary.querySelector("div")?.getAttribute("style")).toBe(
            "margin-left:0rem; word-break: break-all; overflow-wrap: break-word;",
        );
    });

    it("keeps plain variable and comment summaries unchanged", () => {
        expect(
            formatEffectDisplay(
                { type: "v2SetVar", var: "name", operator: "=", value: "Ada", valueType: "value", indent: 2 },
                true,
            ),
        ).toBe(
            '<div class="text-purple-500 line-clamp-4" style="margin-left:2rem; word-break: break-all; overflow-wrap: break-word;">Set Variable <span class="text-yellow-500">name</span> <span class="text-green-500">=</span> <span class="text-green-500">"Ada"</span></div>',
        );
        expect(formatEffectDisplay({ type: "v2Comment", value: "Remember this", indent: 1.5 }, true)).toBe(
            '<div class="text-gray-500 italic line-clamp-4" style="margin-left:1.5rem; word-break: break-all; overflow-wrap: break-word;">// <span class="text-gray-400">Remember this</span></div>',
        );
    });

    it("preserves numeric and boolean field formatting", () => {
        const effect = {
            type: "v2SetLorebookActivation",
            index: 0,
            indexType: "value",
            value: false,
            indent: 0,
        } as unknown as triggerEffect;
        const summary = parseSummary(formatEffectDisplay(effect, true));

        expect(Array.from(summary.querySelectorAll("span"), (span) => span.outerHTML)).toEqual([
            '<span class="text-green-500">"0"</span>',
            '<span class="text-blue-500">false</span>',
        ]);
    });

    it("keeps trusted description markup and honors the supplied support decision", () => {
        const original = language.triggerDesc.v2CommentDesc;
        language.triggerDesc.v2CommentDesc = "<em>Note</em> {{value}}";
        try {
            const effect = { type: "v2Comment", value: "<img src=x>", indent: 0 } satisfies triggerEffect;
            const summary = parseSummary(formatEffectDisplay(effect, true));

            expect(summary.querySelector("em")?.textContent).toBe("Note");
            expect(summary.querySelector("img")).toBeNull();
            expect(summary.textContent).toBe("// Note <img src=x>");
            expect(formatEffectDisplay(effect, false)).toBe('<span class="text-red-500">Unsupported Trigger</span>');
        } finally {
            language.triggerDesc.v2CommentDesc = original;
        }
    });
});

describe("effectDisplayText", () => {
    it("strips summary tags and decodes all five entities for a textContent drag preview", () => {
        const value = `a < b > c & "double" 'single' <img src=x> &lt;literal&gt;`;
        const html = formatEffectDisplay({ type: "v2Comment", value, indent: 0 }, true);
        const preview = document.createElement("div");
        preview.textContent = effectDisplayText(html);

        expect(preview.textContent).toBe(`// ${value}`);
        expect(preview.children).toHaveLength(0);
    });
});
