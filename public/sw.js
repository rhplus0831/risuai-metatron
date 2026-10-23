// @ts-nocheck

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    const path = url.pathname.split('/')
    if(path[1] === 'sw'){
        try {
            switch (path[2]){
                case "check":{
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    event.respondWith(checkCache(targetUrl))
                    break
                }
                case "img": {
                    event.respondWith(getSource(url))
                    break
                }
                case "register": {
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    const noContentType = headers.get('x-no-content-type') === 'true'
                    event.respondWith(
                        registerCache(targetUrl, event.request.arrayBuffer(), noContentType)
                    )
                    break
                }
                case "init":{
                    event.respondWith(new Response("v2"))
                    break
                }
                case 'share':{
                    event.respondWith((async () => {
                        if(event.request.method === 'POST'){
                            const formData = await event.request.formData()
                            for(const kind of ['character', 'preset', 'module']){
                                const file = formData.get(kind)
                                if(file instanceof File){
                                    await registerCache(`/sw/share/${kind}`, file.arrayBuffer(), true)
                                    return Response.redirect(new URL(`/#share_${kind}`, self.location.origin), 303)
                                }
                            }
                        }
                        return Response.redirect(new URL('/', self.location.origin), 303)

                    })())
                    break
                }
                default: {
                    event.respondWith(new Response(
                        path[2]
                    ))
                }
            }
        } catch (error) {
            event.respondWith(new Response(`${error}`))
        }
    }
    if(path[1] === 'tf'){{
        event.respondWith(new Response("Cannot find resource from cache", {
            status: 404
        }))
    }}
})


async function checkCache(url){
    const cache = await caches.open('risuCache')

    if(url.pathname.startsWith("/sw/check")) {
        url.pathname = "/sw/img" + url.pathname.slice(9);
        return new Response(JSON.stringify({
            "able": !!(await cache.match(url))
        }))
    }

    return new Response(JSON.stringify({
        "able": !!(await cache.match(url))
    }))
}

async function getSource(url){
    const cache = await caches.open('risuCache')
    return await cache.match(url)
}

async function check(){

}

async function registerCache(urlr, buffer, noContentType = false){
    const cache = await caches.open('risuCache')
    const url = new URL(urlr, self.location.origin)
    if(!noContentType){
        let path = url.pathname.split('/')
        path[2] = 'img'
        url.pathname = path.join('/')
    }
    const buf = new Uint8Array(await buffer)
    let headers = {
        "cache-control": "max-age=604800",
        "content-type": "image/png"
    }
    if(noContentType){
        delete headers["content-type"]
    }
    await cache.put(url, new Response(buf, {
        headers
    }))
    return new Response(JSON.stringify({
        "done": true
    }))
}
// Web Push for chat completions. A new worker takes over at once, so an installed app gets these
// handlers without closing every tab; the cache routes above keep working (they read `risuCache`,
// which outlives the worker). A rotated subscription (`pushsubscriptionchange`) is not handled
// here: the worker has no credentials, and the page registers it again when it opens.
const NOTIFICATION_LOGO = '/logo_192.png'
// The tag prefix (`shared/notifications.ts` `COMPLETION_NOTIFICATION_TAG`); a push names its chat's tag
// (the prefix, `:`, a hash of the chat), so each chat keeps its own notice.
const COMPLETION_TAG = 'risuai-chat-completion'

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

// Every push is shown, also while a window is in front: Safari revokes the permission of a site whose
// pushes show nothing, and Chrome shows its own notice instead. The page closes them when it is shown.
self.addEventListener('push', (event) => {
    event.waitUntil(showPush(event))
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    event.waitUntil(openFromNotification(safeRoute(event.notification.data && event.notification.data.url)))
})

/** A same-origin chat route or `/`: nothing from a payload is opened unchecked. */
function safeRoute(value){
    if(typeof value !== 'string' || value.length > 4096){
        return '/'
    }
    try {
        const url = new URL(value, self.location.origin)
        if(url.origin === self.location.origin && /^\/chat\/[^/]+\/[^/]+$/.test(url.pathname)){
            return url.pathname
        }
    } catch {}
    return '/'
}

function readPush(event){
    let data = null
    try {
        data = event.data ? event.data.json() : null
    } catch {}
    const text = (value, fallback, max) => typeof value === 'string' && value.trim() ? value.slice(0, max) : fallback
    return {
        title: text(data && data.title, 'Risuai', 200),
        body: text(data && data.body, 'Chat processing complete.', 2000),
        url: safeRoute(data && data.url),
        tag: completionTag(data && data.tag),
    }
}

/** The payload's chat tag when it is a completion tag, else the bare prefix. */
function completionTag(value){
    return typeof value === 'string' && value.length <= 64 && value.startsWith(COMPLETION_TAG + ':')
        ? value
        : COMPLETION_TAG
}

async function showPush(event){
    const push = readPush(event)
    const options = {
        body: push.body,
        tag: push.tag,
        icon: NOTIFICATION_LOGO,
        badge: NOTIFICATION_LOGO,
        data: { url: push.url },
    }
    try {
        await self.registration.showNotification(push.title, options)
    } catch {
        // A browser that rejects an option (a badge, an icon it cannot load): the text alone.
        await self.registration.showNotification(push.title, { body: push.body, tag: push.tag, data: { url: push.url } })
    }
}

/**
 * Focuses a window of the app and asks it to open the chat (`pushNotifications.ts` answers whether it
 * did); a window that does not answer (still loading) is navigated, and with no window, or a navigation
 * the browser refuses (a window this worker does not control), one is opened.
 */
async function openFromNotification(route){
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        .filter((client) => new URL(client.url).origin === self.location.origin)
    const target = windows.find((client) => client.focused) ||
        windows.find((client) => client.visibilityState === 'visible') ||
        windows[0]
    if(!target){
        if(self.clients.openWindow){
            await self.clients.openWindow(route)
        }
        return
    }
    try {
        await target.focus()
    } catch {}
    if(route === '/' || await askToOpen(target, route)){
        return
    }
    try {
        await target.navigate(route)
        return
    } catch {}
    if(self.clients.openWindow){
        try {
            await self.clients.openWindow(route)
        } catch {}
    }
}

function askToOpen(client, route){
    return new Promise((resolve) => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => resolve(false), 2000)
        channel.port1.onmessage = (event) => {
            clearTimeout(timer)
            resolve(!!(event.data && event.data.opened))
        }
        try {
            client.postMessage({ type: 'risu-open-route', url: route }, [channel.port2])
        } catch {
            clearTimeout(timer)
            resolve(false)
        }
    })
}
