import http from 'node:http'
import path from 'node:path'
import { config } from './config.js'
import { Store } from './store.js'
import { ScrapeScheduler } from './scheduler.js'
import { createApp } from './create-app.js'
import { createEventHub } from './event-hub.js'
import { ScrapeLogger } from './scrape-log.js'

const boot = async () => {
  const store = new Store()
  const eventHub = createEventHub()
  const scrapeLog = new ScrapeLogger(path.resolve(process.cwd(), 'data'))
  const scheduler = new ScrapeScheduler({
    store,
    intervalMinMs: config.intervalMinMs,
    intervalMaxMs: config.intervalMaxMs,
    scrapeTimeoutMs: config.scrapeTimeoutMs,
    scrapeRetries: config.scrapeRetries,
    scrapeConcurrency: config.scrapeConcurrency,
    scrapeSequential: !config.scrapeConcurrent,
    scrapeRoundBudgetMs: config.scrapeRoundBudgetMs,
    scrapeStaggerGapMs: config.scrapeStaggerGapMs,
    scrapeFreshContext: config.scrapeFreshContext,
    scrapeProxyServer: config.scrapeProxyServer,
    broadcast: (event, data) => eventHub.broadcast(event, data),
    scrapeLog,
  })

  const app = createApp({ store, scheduler, eventHub, scrapeLog })
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
