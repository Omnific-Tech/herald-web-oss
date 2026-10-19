<div align="center">

# Herald Web

**Web Push for your PWA. Shared subscription controls for Android.**

[Herald broker](https://github.com/Omnific-Tech/herald-oss) · [Herald Android](https://github.com/Omnific-Tech/herald-android-oss) · [Demo PWA](demo/) · [Protocol v1](https://github.com/Omnific-Tech/herald-oss/blob/main/docs/protocol-v1.md)

</div>

Herald Web is a browser notification library for existing Progressive Web Apps. It connects your page and service worker to [Herald](https://github.com/Omnific-Tech/herald-oss), handling browser registration, channel/topic preferences, push delivery, and acknowledgements.

Inside an app built with [Herald Android](https://github.com/Omnific-Tech/herald-android-oss), the same page API manages native notification subscriptions through the Trusted Web Activity bridge. Your product keeps one set of notification controls; device credentials stay in the Android app.

## What it handles

- **Page integration:** VAPID key discovery, permission requests, browser push subscriptions, and device registration.
- **Service worker delivery:** duplicate suppression by `delivery_id`, expiry checks, notification display, and acknowledgements.
- **Notification behavior:** collapse keys and click destinations restricted to your PWA's own origin.
- **Android integration:** subscription changes through the native bridge, with cleanup of earlier browser registrations to avoid duplicate notifications.

The web device token is stored in IndexedDB so the service worker can access it. It authorizes that device's subscription changes and acknowledgements. Producer tokens and server credentials belong on your backend.

## Build and integrate

The package is **not published to npm yet**. Build from this repository and vendor the output into your PWA:

```sh
npm ci
npm run build
```

Use **Node.js 22** as in CI. Copy `dist/` into your product, for example as `vendor/herald-web/`, and retain the repository's license and notice files. The examples below use that local copy; no npm package installation is assumed.

### In your page

```ts
import { createHerald } from './vendor/herald-web/index.js'

const herald = createHerald({
  heraldUrl: 'https://herald.example.com',
  application: 'sample',
})

// From a user action, such as a "Notify me" button:
await herald.enable({
  subscriptions: [{ channel: 'alerts' }, { channel: 'system' }],
})
```

Call `herald.sync()` on each page load to recover when the browser replaces or drops its push subscription. Use `status()`, `setSubscriptions()`, and `disable()` to display and update preferences. Your PWA must register its service worker; the helper uses the ready registration.

The broker must list your PWA's origin in `CORS_ALLOWED_ORIGINS`, and the application's configured origin must match the PWA. Provision the application and its routing catalog before subscribing to topics.

### In your service worker

For a classic worker, serve the built `herald-sw.js` beside your worker:

```js
importScripts('/herald-sw.js')
HeraldSW.install({ fallbackUrl: '/', icon: '/icon-192.png' })
```

For a bundled module worker:

```ts
import { installHerald } from './vendor/herald-web/sw.js'

installHerald(self, { fallbackUrl: '/' })
```

Pushes without a `delivery_id` are ignored, allowing your product to retain other push handlers. The service worker implementation is in [src/sw.ts](src/sw.ts).

## Platform behavior

| Environment | Delivery and integration |
| --- | --- |
| Supported desktop browsers | Web Push through the registered service worker |
| iPhone and iPad | Web Push from a PWA opened from the Home Screen; request permission from a tap |
| Herald Android app with bridge enabled | Native FCM delivery; the page API controls the APK's subscriptions |
| Android app without a working bridge | `status().supported` is false; hide notification controls |

On iOS, ordinary Safari tabs are not supported; show Home Screen installation instructions. The PWA manifest needs `"display": "standalone"`.

Inside Android, `status()`, `enable()`, `setSubscriptions()`, and `disable()` read or replace the APK's subscription set. `status().saved` remains false until the user chooses preferences, so products can apply their own first-launch defaults. Device credentials never cross into the page.

The bridge depends on a compatible TWA browser, the APK's `web_subscription_bridge` setting, and Digital Asset Links. Detection uses the `android-app://` referrer on the first page load and retains it for the tab session. See the [bridge contract](https://github.com/Omnific-Tech/herald-android-oss/blob/main/docs/subscription-bridge.md) and [page bridge implementation](src/bridge.ts).

Handle `HeraldError.code` in your UI. Codes include unsupported environments, denied permission, push-service refusal, invalid subscriptions, and request failures; see [error definitions](src/errors.ts). For example, Brave may require enabling its Google push service before subscriptions succeed.

## Try the demo

`demo/` is a minimal PWA for checking a real broker and device:

```sh
npm run dev
```

By default it uses Herald at `http://localhost:8080` with application `demo`. Configure `VITE_HERALD_URL` and `VITE_HERALD_APPLICATION` for your own instance, provision a matching application, and allow the demo origin in the broker's CORS settings.

To host the demo, run `npm ci && npm run build:demo`, then `npx wrangler deploy`. Set those build variables and update `connect-src` in [demo/public/_headers](demo/public/_headers) to your broker origin before deployment. The included policy uses a generic example.

## Verification

```sh
npm run lint
npm run test:e2e
npm run test:e2e:report
```

The E2E suite requires **Docker, Go, installed Google Chrome, and network access**. It starts a throwaway PostgreSQL container on port 5435 and builds the pinned broker fixture in `e2e/vendor/`. Set `HERALD_DIR` to test an explicit broker checkout instead. Fixture source and SHA-256 are recorded in [provenance](e2e/vendor/PROVENANCE.txt); private deployment configuration and credentials are excluded.

The real push-service scenario sends through the browser's push service and retries for its latency/refusals. Other scenarios inject broker-stored delivery envelopes through DevTools, including cases such as an already-expired message. CI retains the HTML report, screenshots, and failure traces for seven days.

Notification clicks, Safari, Firefox, and iOS are not covered by this automated suite. Verify those on real devices with the demo. This client implements Herald protocol v1; [src/protocol.ts](src/protocol.ts) mirrors its delivery types.

## License and toolkit

[Apache License 2.0](LICENSE) · [Copyright notice](NOTICE)

[Herald broker](https://github.com/Omnific-Tech/herald-oss) · [Herald Android](https://github.com/Omnific-Tech/herald-android-oss) · [Omnific Tech](https://omnific.dev/)
