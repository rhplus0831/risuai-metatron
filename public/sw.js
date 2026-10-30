// @ts-nocheck

let cachedAssetAuth = null
let assetAuthPromise = null
const ASSET_DESTINATIONS = ['image', 'audio', 'video', 'track', 'style', 'font']

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    const allowedAssetRequest = url.origin === self.location.origin &&
        (event.request.method === 'GET' || event.request.method === 'HEAD') &&
        typeof event.clientId === 'string' && event.clientId.length > 0 &&
        ASSET_DESTINATIONS.includes(event.request.destination)
    if(allowedAssetRequest && url.pathname.startsWith('/api/asset/')){
        event.respondWith(fetchAsset(event.request))
        return
    }
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
                    event.respondWith(getSource(url, allowedAssetRequest ? event.request : null))
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
                    event.respondWith(new Response(JSON.stringify({ version: 'v3', directAssets: true }), {
                        headers: { 'content-type': 'application/json' }
                    }))
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

/** Reads the page's key without leaving a new database behind before the page creates its store. */
function readAssetKeyPair(){
    return new Promise((resolve) => {
        let db = null
        let settled = false
        const finish = (keyPair = null) => {
            if(db){
                db.close()
            }
            if(!settled){
                settled = true
                resolve(keyPair)
            }
        }
        let request
        try {
            request = indexedDB.open('DPoPDB', 1)
        } catch {
            finish()
            return
        }
        request.onupgradeneeded = () => {
            db = request.result
            request.transaction.abort()
            finish()
        }
        request.onerror = () => finish()
        request.onblocked = () => finish()
        request.onsuccess = () => {
            db = request.result
            if(settled){
                db.close()
                return
            }
            try {
                if(!db.objectStoreNames.contains('node')){
                    finish()
                    return
                }
                const transaction = db.transaction('node', 'readonly')
                const read = transaction.objectStore('node').get('dpop')
                transaction.oncomplete = () => finish(read.result || null)
                transaction.onabort = () => finish()
                transaction.onerror = () => finish()
                read.onerror = () => finish()
            } catch {
                finish()
            }
        }
    })
}

function assetBase64url(bytes){
    return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Keep the JWT format and UTF-8 encoding in parity with serverAuth.ts createAuth. */
async function signAssetAuth(){
    const keyPair = await readAssetKeyPair()
    if(!keyPair){
        return null
    }
    const iat = Math.floor(Date.now() / 1000)
    const header = { alg: 'ES256', typ: 'JWT' }
    const payload = {
        iat,
        exp: iat + 300,
        pub: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    }
    const encoder = new TextEncoder()
    const unsigned = assetBase64url(encoder.encode(JSON.stringify(header))) + '.' +
        assetBase64url(encoder.encode(JSON.stringify(payload)))
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, encoder.encode(unsigned)
    )
    return { token: unsigned + '.' + assetBase64url(new Uint8Array(signature)), exp: payload.exp }
}

/** Concurrent loads share a signer; missing keys and failures can be tried again on the next load. */
async function getAssetAuth(){
    if(cachedAssetAuth && Date.now() / 1000 < cachedAssetAuth.exp - 60){
        return cachedAssetAuth
    }
    if(!assetAuthPromise){
        assetAuthPromise = signAssetAuth().then((auth) => {
            cachedAssetAuth = auth
            return auth
        }).finally(() => {
            assetAuthPromise = null
        })
    }
    return assetAuthPromise
}

/** A fresh same-origin request permits the auth header even for no-cors media loads. */
function fetchSignedAsset(request, token){
    const headers = new Headers({ 'risu-auth': token })
    for(const name of ['Range', 'If-Range']){
        const value = request.headers.get(name)
        if(value !== null){
            headers.set(name, value)
        }
    }
    return fetch(request.url, {
        method: request.method,
        headers,
        mode: 'same-origin',
        credentials: 'omit',
        cache: 'default',
        signal: request.signal
    })
}

/** Only a 401 retries auth; network failures and aborts from the signed fetch stay rejected. */
async function fetchAsset(request){
    let auth
    try {
        auth = await getAssetAuth()
    } catch {
        return fetch(request)
    }
    if(!auth){
        return fetch(request)
    }
    const response = await fetchSignedAsset(request, auth.token)
    if(response.status !== 401){
        return response
    }
    // A late failure must not discard a token another request has already refreshed.
    if(cachedAssetAuth === auth){
        cachedAssetAuth = null
    }
    try {
        auth = await getAssetAuth()
    } catch {
        return fetch(request)
    }
    return auth ? fetchSignedAsset(request, auth.token) : fetch(request)
}


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

async function getSource(url, request = null){
    const cache = await caches.open('risuCache')
    const response = await cache.match(url)
    if(response || !request || !url.pathname.startsWith('/sw/img/')){
        return response
    }
    const assetUrl = new URL('/api/asset/' + url.pathname.slice('/sw/img/'.length), self.location.origin)
    const headers = new Headers()
    for(const name of ['Range', 'If-Range']){
        const value = request.headers.get(name)
        if(value !== null){
            headers.set(name, value)
        }
    }
    return fetchAsset(new Request(assetUrl, {
        method: request.method,
        headers,
        signal: request.signal
    }))
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
// handlers without closing every tab. Activation removes stored asset copies under `/sw/img/`
// from `risuCache` and keeps share files. A `/sw/img/` miss from an allowed subresource is answered
// from the signed `/api/asset/` route. A rotated subscription (`pushsubscriptionchange`) is not
// handled here: push has no credentials, and the page registers it again when it opens. Only asset
// requests read the page's signing key.
const NOTIFICATION_LOGO = '/logo_192.png'
// The tag prefix (`shared/notifications.ts` `COMPLETION_NOTIFICATION_TAG`); a push names its chat's tag
// (the prefix, `:`, a hash of the chat), so each chat keeps its own notice.
const COMPLETION_TAG = 'risuai-chat-completion'
// The worker's content-free push records (`shared/diagnostics.ts` `BROWSER_PUSH_PHASES`), which the
// page's diagnostic report reads (`src/ts/diagnostics/workerRecords.ts`, same names): fixed phases and
// booleans only, never a payload, title, body, route, endpoint, or error text. The newest 100 are kept.
const PUSH_RECORDS_DB = 'risu-sw-diagnostics'
const PUSH_RECORDS_STORE = 'records'
const MAX_PUSH_RECORDS = 100
/** A write that has not completed by then is given up (a blocked or slow database). */
const PUSH_RECORDS_WAIT_MS = 2000

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        try {
            const cache = await caches.open('risuCache')
            const requests = await cache.keys()
            await Promise.allSettled(requests.map(async (request) => {
                if(new URL(request.url).pathname.startsWith('/sw/img/')){
                    await cache.delete(request)
                }
            }))
        } catch {}
        await self.clients.claim()
    })())
})

// Every push is shown, also while a window is in front: Safari revokes the permission of a site whose
// pushes show nothing, and Chrome shows its own notice instead. The page closes them when it is shown.
self.addEventListener('push', (event) => {
    event.waitUntil(showPush(event))
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const record = pushRecord('clicked')
    const opened = openFromNotification(safeRoute(event.notification.data && event.notification.data.url))
    // Recorded after the window work, whatever its outcome (which stays the event's).
    event.waitUntil(opened.finally(() => appendPushRecords([record])))
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

/** Numbers this worker's pushes, so a push closes its own notification and not a later one of its tag. */
let pushCount = 0
/**
 * Pushes are shown one at a time: Chromium closes a notification by its tag, so a push's close must not
 * land after a later push of the same tag replaced it.
 */
let pushQueue = Promise.resolve()

function showPush(event){
    // Stamped on arrival, so the time from the server's `accepted` does not include this queue.
    const records = [pushRecord('received')]
    const shown = pushQueue.then(() => showPushNow(event, records))
    pushQueue = shown.catch(() => {})
    // Written once the display settled, outside the queue: a slow or failed write delays neither this
    // notification nor the next push's. The display's rejection stays the event's.
    return shown.then(
        () => appendPushRecords(records),
        (error) => appendPushRecords(records).then(() => { throw error }),
    )
}

/**
 * Tells the app's windows (`windowState`'s list) which chat a completion push is for
 * (`risu-push-completion`), so a tab whose follow of that job was lost reads the chat again
 * (`pushNotifications.ts`). Sent before the display, whatever it does; a push for no chat says
 * nothing. Best effort: a window whose post fails is skipped, and nothing of the payload but the
 * checked route is sent.
 */
function announceCompletion(windows, route){
    if(route === '/'){
        return
    }
    for(const client of windows){
        try {
            client.postMessage({ type: 'risu-push-completion', url: route })
        } catch {}
    }
}

/**
 * Every push shows a notification (Safari ends a subscription whose pushes show none). While a window of
 * the app is in front (`windowState`'s `inFront`), the notification is silent, so it does not sound
 * after the page's message sound (`playMessage`), and it is closed once shown if the window is still in
 * front (best effort: a browser without `getNotifications` keeps it). Otherwise `silent` is left out: the platform's own
 * default applies.
 *
 * `records` (its `received` first) gets this push's records: the window state the display was decided
 * by, then `shown` or `shownSilent`, `showFailed` when neither show worked, and `closedInFront` when the
 * second check closed it.
 */
async function showPushNow(event, records){
    const push = readPush(event)
    const state = await windowState()
    announceCompletion(state.windows, push.url)
    records[0].inFront = state.inFront
    records[0].focusedHidden = state.focusedHidden
    const inFront = state.inFront
    const quiet = inFront ? { silent: true } : {}
    const data = { url: push.url, push: ++pushCount }
    const options = {
        body: push.body,
        tag: push.tag,
        icon: NOTIFICATION_LOGO,
        badge: NOTIFICATION_LOGO,
        ...quiet,
        data,
    }
    try {
        await self.registration.showNotification(push.title, options)
    } catch {
        // A browser that rejects an option (a badge, an icon it cannot load): the text alone.
        try {
            await self.registration.showNotification(push.title, { body: push.body, tag: push.tag, ...quiet, data })
        } catch (error) {
            records.push(pushRecord('showFailed', state))
            throw error
        }
    }
    records.push(pushRecord(inFront ? 'shownSilent' : 'shown', state))
    if(inFront){
        try {
            const listed = await self.registration.getNotifications({ tag: push.tag })
            const again = await windowState()
            if(again.inFront){
                let closed = false
                for(const notification of listed){
                    if(notification.data && notification.data.push === data.push){
                        notification.close()
                        closed = true
                    }
                }
                if(closed){
                    records.push(pushRecord('closedInFront', again))
                }
            }
        } catch {}
    }
}

/**
 * The app's same-origin windows (`windows`) and whether one is in front (`inFront`): focused and visible
 * on the same window. A focused window can be hidden (an Android PWA left for another app keeps the
 * focus), and a push for it must still sound and stay; `focusedHidden` says such a window was there. A
 * failed lookup counts as no window.
 */
async function windowState(){
    try {
        const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
            .filter((client) => new URL(client.url).origin === self.location.origin)
        return {
            windows,
            inFront: windows.some((client) => client.focused && client.visibilityState === 'visible'),
            focusedHidden: windows.some((client) => client.focused && client.visibilityState !== 'visible'),
        }
    } catch {
        return { windows: [], inFront: false, focusedHidden: false }
    }
}

/** A push record of `phase`, stamped now, with the window state when given. */
function pushRecord(phase, state){
    const record = { at: Date.now(), kind: 'push', phase }
    if(state){
        record.inFront = state.inFront === true
        record.focusedHidden = state.focusedHidden === true
    }
    return record
}

/**
 * Appends `records` to the record store and prunes it to the newest 100, in one transaction. Never
 * rejects: no IndexedDB, a failed or blocked open, a failed transaction, or one not done within 2 s is
 * skipped (a connection that opens after that is closed, and an abandoned transaction is aborted).
 */
function appendPushRecords(records){
    return new Promise((resolve) => {
        let db = null
        let transaction = null
        let settled = false
        let timer = null
        const finish = () => {
            if(settled){
                return
            }
            settled = true
            clearTimeout(timer)
            if(transaction){
                try {
                    transaction.abort()
                } catch {}
            }
            if(db){
                try {
                    db.close()
                } catch {}
            }
            resolve()
        }
        let request
        try {
            request = indexedDB.open(PUSH_RECORDS_DB, 1)
        } catch {
            finish()
            return
        }
        timer = setTimeout(finish, PUSH_RECORDS_WAIT_MS)
        request.onupgradeneeded = () => {
            try {
                request.result.createObjectStore(PUSH_RECORDS_STORE, { autoIncrement: true })
            } catch {}
        }
        request.onerror = () => finish()
        request.onblocked = () => finish()
        request.onsuccess = () => {
            if(settled){
                request.result.close()
                return
            }
            db = request.result
            try {
                transaction = db.transaction(PUSH_RECORDS_STORE, 'readwrite')
                const store = transaction.objectStore(PUSH_RECORDS_STORE)
                for(const record of records){
                    store.add(record)
                }
                const keys = store.getAllKeys()
                keys.onsuccess = () => {
                    const all = keys.result
                    if(all.length > MAX_PUSH_RECORDS){
                        store.delete(IDBKeyRange.upperBound(all[all.length - MAX_PUSH_RECORDS - 1]))
                    }
                }
                transaction.oncomplete = () => {
                    transaction = null
                    finish()
                }
                transaction.onabort = () => {
                    transaction = null
                    finish()
                }
            } catch {
                finish()
            }
        }
    })
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
