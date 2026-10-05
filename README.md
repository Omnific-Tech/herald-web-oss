# herald-web

Herald Web Push client for product PWAs on desktop, iPhone and iPad. Android
product APKs use [herald-android](https://github.com/Omnific-Tech/herald-android)
instead.

Products install this package into their existing PWA. It is a library, not a
template: a protocol fix ships as a new version rather than a patch to every
copy.

## What it does

The page helper fetches the application's VAPID key from Herald, asks for
notification permission, subscribes the browser, registers it with Herald as a
`web` device, and sets its channel subscriptions.

The service worker handler receives the Herald delivery envelope, drops
duplicates by `delivery_id`, suppresses already-expired messages, shows the
notification (collapsing on `collapse_key`), and acknowledges the outcome. A
click opens the message link only when it is a path on the PWA's own origin.

The device token is stored in IndexedDB because the service worker cannot read
`localStorage`. It authorizes only this device's acknowledgements and
subscriptions.

## Using it in a product

The package is not published yet. Products copy its build: run
`npm run build` here and copy `dist/` into the product, which is safe because
the JavaScript ends up in the product's public bundle anyway. The imports
below then point at that copy instead of the package name.

In the page, from a user action such as a "Notify me" button:

```ts
import { createHerald } from '@omnific-tech/herald-web'

const herald = createHerald({ heraldUrl: 'https://herald.example.com', application: 'sample' })

await herald.enable({ subscriptions: [{ channel: 'alerts' }, { channel: 'system' }] })
```

Call `herald.sync()` on each page load. It re-registers when the browser has
replaced or dropped the push subscription. `status()`, `setSubscriptions()` and
`disable()` cover the rest.

In the service worker, either load the classic build (copy
`node_modules/@omnific-tech/herald-web/dist/herald-sw.js` next to your worker):

```js
importScripts('/herald-sw.js')
HeraldSW.install({ fallbackUrl: '/', icon: '/icon-192.png' })
```

or, for a bundled worker:

```ts
import { installHerald } from '@omnific-tech/herald-web/sw'

installHerald(self, { fallbackUrl: '/' })
```

Pushes without a `delivery_id` are ignored, so a product can keep its own push
handling alongside.

Herald must list the product's origin in `CORS_ALLOWED_ORIGINS`, and the
application's origin in Herald must match the PWA.

`enable()` rejects with a `HeraldError` whose `code` says why:
`unsupported`, `android_app`, `permission_denied`, `push_unavailable` (the
browser's push service refused, as Brave does until "Use Google services for
push messaging" is turned on), `invalid_subscriptions` (the Android app
rejected the set) or `request_failed`.

### Inside the Android app

A herald-android product APK opens the same PWA in a Trusted Web Activity and
delivers notifications natively, so Web Push is never used there. When the
APK enables its subscription bridge, the same calls work unchanged:
`status()`, `enable()`, `setSubscriptions()` and `disable()` read and replace
the APK's subscription set over the Trusted Web Activity message channel. The
device token stays in the APK. `status().saved` is `false` until the user has
chosen, so a product can apply its own defaults on first launch.

Without the bridge (disabled in the APK, or a default browser that cannot run
a Trusted Web Activity), `status().supported` is `false` and `enable()`
rejects with `android_app`; hide the control. In either case `sync()` removes
any web registration made earlier in Chrome on that phone, so it is not
notified twice.

Detection relies on the `android-app://` referrer Chrome gives the app's first
page load, kept for the tab's session. The bridge protocol is documented in
`src/bridge.ts` and in herald-android's README.

### iPhone and iPad

Safari delivers Web Push only to a PWA opened from the Home Screen, and only
after permission is requested from a tap. In a normal Safari tab
`isSupported()` returns `false`; show install instructions instead of the
button. The PWA needs a manifest with `"display": "standalone"`.

## Push test page

`demo/` is a minimal PWA for checking delivery on real devices. It reads
`VITE_HERALD_URL` and `VITE_HERALD_APPLICATION` at build time.

```sh
npm run dev    # against Herald on localhost:8080, application "demo"
```

Deployed as the Cloudflare Worker `herald-push-test`:

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build:demo` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `VITE_HERALD_URL`, `VITE_HERALD_APPLICATION` |

Create a matching application in Herald's admin UI with the test page's origin,
add that origin to `CORS_ALLOWED_ORIGINS`, and update `connect-src` in
`demo/public/_headers` to allow your own broker origin. Its default is a generic
example and must be replaced for a deployed demo.

## Tests

```sh
npm run test:e2e
npm run test:e2e:report
```

The suite builds and runs Herald from `HERALD_DIR` (default `../herald`)
against a throwaway Postgres container it starts on port 5435 and removes
afterwards (Docker and Go are required), and drives installed Google Chrome with real push
subscriptions, so the tests need network access. `push-service.spec.ts` sends
through the real push service and retries, since that service's latency and
occasional refusals are outside the suite's control. The other specs hand the
service worker the envelope Herald stored for the delivery through the DevTools
protocol, as they do for cases Herald never sends, such as an already-expired
message.

Not covered: notification clicks (no automation hook in headless Chrome),
Safari, Firefox, and iOS. Check those on real devices with the test page.

CI checks out a pinned public Herald revision without a deploy key. Local tests
can use a reviewed sibling checkout with `HERALD_DIR`. Reports are retained for
both passing and failing runs; service credentials/state files are excluded.
Set repository variable `HERALD_SOURCE_REVISION` to the reviewed broker commit.

## Protocol

This client speaks Herald protocol v1, defined in the herald repository at
`docs/protocol-v1.md`. `src/protocol.ts` mirrors it.
