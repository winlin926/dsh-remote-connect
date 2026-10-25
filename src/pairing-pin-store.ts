import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface PairingPinState { pin?: string; pinConsent?: boolean }
export interface PairingPinStore {
  load(): PairingPinState
  save(state: PairingPinState): void
}

export function readPairingPinState(path: string): PairingPinState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pin?: unknown; pinConsent?: unknown }
    return {
      ...(typeof parsed.pin === 'string' && /^\d{6}$/.test(parsed.pin) ? { pin: parsed.pin } : {}),
      ...(typeof parsed.pinConsent === 'boolean' ? { pinConsent: parsed.pinConsent } : {})
    }
  } catch { return {} }
}

export function createFilePairingPinStore(path: string, migrateFrom?: string): PairingPinStore {
  return {
    load: () => {
      if (!existsSync(path) && migrateFrom) {
        const migrated = readPairingPinState(migrateFrom)
        if (migrated.pin || migrated.pinConsent !== undefined) {
          writePairingPinState(path, migrated)
          return migrated
        }
      }
      return readPairingPinState(path)
    },
    save: state => writePairingPinState(path, state)
  }
}

export function writePairingPinState(path: string, state: PairingPinState): void {
  const document: PairingPinState = {}
  if (state.pinConsent === true) {
    document.pinConsent = true
    if (typeof state.pin === 'string' && /^\d{6}$/.test(state.pin)) document.pin = state.pin
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    restrictSecretAcl(temporary)
    renameSync(temporary, path)
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
}

/** Windows does not enforce POSIX mode bits, so secret files need an explicit ACL. */
function restrictSecretAcl(path: string): void {
  if (process.platform !== 'win32') return
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'], { stdio: 'ignore', windowsHide: true })
  } catch (error) {
    throw new Error(`无法收紧连接密码文件权限：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readLegacyPairingPin(settingsFile: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as { initialPin?: unknown }
    return typeof parsed.initialPin === 'string' && /^\d{6}$/.test(parsed.initialPin) ? parsed.initialPin : undefined
  } catch { return undefined }
}
