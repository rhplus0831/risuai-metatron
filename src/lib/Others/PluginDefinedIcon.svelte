<script lang="ts">
    import DOMPurify from "dompurify";

    /**
     * Renders plugin-supplied icons from `src/ts/plugins/apiV3/v3.svelte.ts`. HTML must pass
     * DOMPurify with active/embed tags and styling attributes forbidden; image URLs must be absolute
     * HTTP, HTTPS, data, or blob URLs. Invalid or disallowed URLs become empty sources.
     */

    let {
        ico,
        className,
    }: {
        ico: {
            iconType: "html" | "img" | "none";
            icon: string;
        };
        className?: string;
    } = $props();

    const iconPurify = (icon: string) => {
        return DOMPurify.sanitize(icon, {
            FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
            FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover", "style", "class"],
        });
    };

    const isSafeSchema = (url: string) => {
        try {
            const parsedUrl = new URL(url);
            const allowedProtocols = ["http:", "https:", "data:", "blob:"];
            if (allowedProtocols.includes(parsedUrl.protocol)) {
                return url;
            } else {
                console.warn(`Blocked URL with unsafe protocol: ${parsedUrl.protocol}`);
                return "";
            }
        } catch (e) {
            console.warn(`Invalid URL: ${url}`);
            return "";
        }
    };
</script>

<div
    class={{
        "w-5 h-5": !className,
        [className]: className,
    }}
>
    {#if ico.iconType === "html"}
        {@html iconPurify(ico.icon)}
    {:else if ico.iconType === "img"}
        <img src={isSafeSchema(ico.icon)} alt="icon" />
    {/if}
</div>
