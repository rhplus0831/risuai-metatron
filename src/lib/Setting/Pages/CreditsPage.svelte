<script lang="ts">
    import { CodeXmlIcon, ExternalLinkIcon, GitForkIcon, LightbulbIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { Component } from "svelte";

    /**
     * Where this app's source is, the project it is a fork of, and the projects whose features, policies, and bug
     * fixes were studied for it. The last group repeats the Acknowledgements section of `README.md`: change both
     * together.
     *
     * Every group has a title, so no card stands between two groups without one. A project with no public
     * repository is listed without a link.
     */
    interface Project {
        name: string;
        description: () => string;
        url?: string;
    }
    interface Group {
        id: string;
        icon: Component;
        title: () => string;
        description?: () => string;
        projects: Project[];
    }

    const groups: Group[] = [
        {
            id: "original",
            icon: CodeXmlIcon,
            title: () => language.creditsPage.original.title,
            projects: [
                {
                    name: "Risuai",
                    description: () => language.creditsPage.original.risuai,
                    url: "https://github.com/kwaroran/Risuai",
                },
            ],
        },
        {
            id: "fork",
            icon: GitForkIcon,
            title: () => language.creditsPage.fork.title,
            projects: [
                {
                    name: "Risuai Metatron",
                    description: () => language.creditsPage.fork.metatron,
                    url: "https://github.com/rhplus0831/risuai-metatron",
                },
            ],
        },
        {
            id: "references",
            icon: LightbulbIcon,
            title: () => language.creditsPage.references.title,
            description: () => language.creditsPage.references.description,
            projects: [
                {
                    name: "PocketRisu",
                    description: () => language.creditsPage.references.pocketRisu,
                    url: "https://github.com/PocketRisu/PocketRisu",
                },
                {
                    name: "RisuBard",
                    description: () => language.creditsPage.references.risuBard,
                    url: "https://github.com/rpaddict/RisuBard",
                },
                {
                    name: "HaejeokRisuai",
                    description: () => language.creditsPage.references.haejeokRisuai,
                    url: "https://github.com/nevaeh5379/HaejeokRisuai",
                },
                {
                    name: "RisuNest",
                    description: () => language.creditsPage.references.risuNest,
                    url: "https://github.com/rsyumi/RisuNest",
                },
                {
                    name: "Archive Center",
                    description: () => language.creditsPage.references.memorySystem,
                    url: "https://github.com/Flazer31/archive-center",
                },
                {
                    name: "Dusk Atelier",
                    description: () => language.creditsPage.references.memorySystem,
                    url: "https://github.com/Pyser08/Dusk-Atelier",
                },
                {
                    name: "HypaPlus-R",
                    description: () => language.creditsPage.references.memorySystem,
                },
            ],
        },
    ];
</script>

{#snippet card(group: Group, project: Project)}
    <group.icon aria-hidden="true" class="h-6 w-6 shrink-0 text-textcolor2" />
    <span class="min-w-0 grow">
        <span class="block font-semibold text-textcolor">{project.name}</span>
        <span class="mt-0.5 block text-sm break-words text-textcolor2">{project.description()}</span>
    </span>
    {#if project.url}
        <ExternalLinkIcon aria-hidden="true" class="h-5 w-5 shrink-0 text-textcolor2" />
    {/if}
{/snippet}

<h2 class="text-2xl font-bold mt-2">{language.creditsPage.title}</h2>
<p class="mt-1 text-sm text-textcolor2">{language.creditsPage.description}</p>

<div class="flex w-full max-w-2xl flex-col">
    {#each groups as group (group.id)}
        <section class="mt-6" aria-labelledby="credits-{group.id}" data-credits-group={group.id}>
            <h3 id="credits-{group.id}" class="text-lg font-semibold">{group.title()}</h3>
            {#if group.description}
                <p class="mt-1 text-sm text-textcolor2">{group.description()}</p>
            {/if}
            <ul class="mt-3 flex flex-col gap-2">
                {#each group.projects as project (project.name)}
                    <li>
                        {#if project.url}
                            <a
                                href={project.url}
                                target="_blank"
                                rel="nofollow noopener noreferrer"
                                class="flex items-center gap-4 rounded-md border border-darkborderc p-4 hover:bg-selected focus-visible:ring-2 focus-visible:ring-selected"
                            >
                                {@render card(group, project)}
                            </a>
                        {:else}
                            <div class="flex items-center gap-4 rounded-md border border-darkborderc p-4">
                                {@render card(group, project)}
                            </div>
                        {/if}
                    </li>
                {/each}
            </ul>
        </section>
    {/each}
</div>

<p class="mt-6 max-w-2xl text-sm text-textcolor2">{language.creditsPage.license}</p>
