importScripts('/herald-sw.js')

HeraldSW.install({ fallbackUrl: '/', icon: '/icon-192.png' })

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
