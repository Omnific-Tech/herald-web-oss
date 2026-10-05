import { installHerald, type HeraldWorkerOptions } from './sw'

// For service workers loaded with importScripts():
//   importScripts('/herald-sw.js')
//   HeraldSW.install({ fallbackUrl: '/' })
declare const self: ServiceWorkerGlobalScope & { HeraldSW: { install(options?: HeraldWorkerOptions): void } }

self.HeraldSW = { install: (options) => installHerald(self, options) }
