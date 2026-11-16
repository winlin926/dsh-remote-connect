#!/usr/bin/env node
/**
 * Operator escape hatch for a lost Host credential: delete one Host and every row scoped to it
 * directly in SQLite (the same cascading deletion `DELETE /v1/hosts/:hostId` performs).
 */
import { loadConfig } from '../config.js'
import { openDatabase } from '../db.js'
import { Repositories } from '../repositories.js'

function fail(message: string, code: number): void {
  process.stderr.write(`${message}\n`)
  process.exitCode = code
}

function main(): void {
  const hostId = process.argv[2]?.trim() ?? ''
  if (hostId === '') {
    fail('用法：node dist/remote-server/src/tools/reset-host.js <hostId>', 2)
    return
  }
  const config = loadConfig(process.env)
  const database = openDatabase(config.databasePath)
  try {
    const repos = new Repositories(database)
    if (!repos.findHostById(hostId)) {
      fail(`主机不存在：${hostId}`, 1)
      return
    }
    const deleted = repos.deleteHost(hostId)
    process.stdout.write(`${JSON.stringify({ hostId, deleted }, null, 2)}\n`)
  } catch (failure) {
    fail(`删除主机失败：${failure instanceof Error ? failure.message : String(failure)}`, 1)
  } finally {
    database.close()
  }
}

main()
