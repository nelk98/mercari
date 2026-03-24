import http from 'node:http'
import { config } from './config.js'
import { Store } from './store.js'
import { ScrapeScheduler } from './scheduler.js'
import { createApp } from './create-app.js'

const boot = async () => {
  const store = new Store()
  const scheduler = new ScrapeScheduler({
    store,
    intervalMinMs: config.intervalMinMs,
    intervalMaxMs: config.intervalMaxMs,
    scrapeTimeoutMs: config.scrapeTimeoutMs,
    scrapeRetries: config.scrapeRetries,
    scrapeConcurrency: config.scrapeConcurrency,
    scrapeFreshContext: config.scrapeFreshContext,
    scrapeProxyServer: config.scrapeProxyServer,
  })

  const app = createApp({ store, scheduler })
  const server = http.createServer(app)

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on http://localhost:${config.port}`)
  })

  scheduler.start()

  const shutdown = () => {
    scheduler.stop()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

boot().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[server] fatal error', error)
  process.exit(1)
})
