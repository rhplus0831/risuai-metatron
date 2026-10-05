<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { getCustomBackground, getEmotion } from "../../ts/util";

    import { DBState } from "src/ts/stores.svelte";
    import { CharEmotion, selectedCharID } from "../../ts/stores.svelte";
    import ResizeBox from "./ResizeBox.svelte";
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from "../../etc/bg.jpg";
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    let openChatList = $state(false);
    let openModuleList = $state(false);

    const wallPaper = `background: url(${defaultWallpaper})`;
    const externalStyles =
        "background: " +
        (settings.ui.textScreenColor ? settings.ui.textScreenColor + "80" : "rgba(0,0,0,0.8)") +
        ";\n" +
        (settings.ui.textBorder
            ? "text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;"
            : "") +
        (settings.ui.textScreenRounded ? "border-radius: 2rem; padding: 1rem;" : "") +
        (settings.ui.textScreenBorder ? `border: 0.3rem solid ${settings.ui.textScreenBorder};` : "");
    let bgImg = $state("");
    let lastBg = $state("");
    $effect.pre(() => {
        (async () => {
            if (settings.ui.customBackground !== lastBg) {
                lastBg = settings.ui.customBackground;
                bgImg = await getCustomBackground(settings.ui.customBackground);
            }
        })();
    });
</script>

{#if settings.ui.theme === "waifu"}
    <div class="grow h-full flex justify-center relative" style={bgImg.length < 4 ? wallPaper : bgImg}>
        <SideBarArrow />
        <BackgroundDom />
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== "none"}
                <div
                    class="h-full mr-10 flex justify-end halfw"
                    style:width="{42 * (settings.ui.waifuWidth2 / 100)}rem"
                >
                    <TransitionImage classType="waifu" src={getEmotion(DBState.db, $CharEmotion, "plain")} />
                </div>
            {/if}
        {/if}
        <div
            class="h-full w-2xl"
            style:width="{42 * (settings.ui.waifuWidth / 100)}rem"
            class:halfwp={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== "none"}
        >
            <DefaultChatScreen
                customStyle={`${externalStyles}backdrop-filter: blur(4px);`}
                bind:openChatList
                bind:openModuleList
            />
        </div>
    </div>
{:else}
    <div class="grow h-full min-w-0 relative justify-center flex">
        <SideBarArrow />
        <BackgroundDom />
        <div style={bgImg} class="h-full w-full" class:max-w-6xl={settings.ui.classicMaxWidth}>
            {#if $selectedCharID >= 0}
                {#if DBState.db.characters[$selectedCharID].viewScreen !== "none" && (DBState.db.characters[$selectedCharID].type === "group" || !DBState.db.characters[$selectedCharID].inlayViewScreen)}
                    <ResizeBox />
                {/if}
            {/if}
            <DefaultChatScreen
                customStyle={bgImg.length > 2 ? `${externalStyles}` : ""}
                bind:openChatList
                bind:openModuleList
            />
        </div>
    </div>
{/if}
{#if openChatList}
    <ChatList
        close={() => {
            openChatList = false;
        }}
    />
{:else if openModuleList}
    <ModuleChatMenu
        close={() => {
            openModuleList = false;
        }}
    />
{/if}

<style>
    .halfw {
        max-width: calc(50% - 5rem);
    }
    .halfwp {
        max-width: calc(50% - 5rem);
    }
</style>
