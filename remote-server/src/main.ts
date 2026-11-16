#!/usr/bin/env node
import { createApp } from './app.js'

/** Process entrypoint: bind the node and shut it down cleanly on signals. */
async function main(): Promise<void> {
  const app = await createApp()
  const address = await app.listen()
  app.logger.info({
    event: 'server.listening',
    host: address.address,
    port: address.port,
    nodeName: app.config.nodeName,
    version: app.config.nodeVersion,
    capabilities: app.config.capabilities,
    turn: app.services.turn.enabled,
    publicOrigin: app.config.publicOrigin,
  })

  let stopping = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return
    stopping = true
    app.logger.info({ event: 'server.stopping', signal })
    try {
      await app.close()
      process.exitCode = 0
    } catch (error) {
      app.logger.error({ event: 'server.stop.failed', error })
      process.exitCode = 1
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(error => {
  process.stderr.write(`remote-server failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
