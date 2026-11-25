<script lang="ts">
    import { language } from "src/lang";

    /**
     * The notice `src/main.ts` mounts in place of the app when the injected server flag (`isNodeServer`) is false
     * (static hosting, a bare `vite build` output). It is English only (`language.nodeServerRequiredTitle`/`Desc`):
     * `changeLanguage` runs only after the database loads, which never happens on this path.
     */
</script>

<div
    class="w-full min-h-screen flex flex-col items-center justify-center gap-3 p-6 bg-bgcolor text-textcolor text-center"
>
    <h1 class="text-2xl font-bold">{language.nodeServerRequiredTitle}</h1>
    <p class="max-w-xl text-textcolor2 whitespace-pre-line">{language.nodeServerRequiredDesc}</p>
</div>
