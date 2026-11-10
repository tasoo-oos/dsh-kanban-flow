/**
 * dsh-kanban-flow — board persistence (host side, no cordis; unit-testable).
 *
 * The board file `<workspace>/.dsh-kanban-flow.json` is the source of truth.
 * This store keeps a per-workspace cache in front of it and guarantees:
 *
 *  - A failed load never becomes an authoritative board. When the file cannot
 *    be resolved, stat'ed or read, reads fail (or serve the last good board
 *    marked stale) and every mutation is refused, so an empty placeholder can
 *    never be written over the real file.
 *  - Failed lookups are retried on the next access instead of being cached
 *    until restart.
 *  - External edits are picked up: every access compares the file's version
 *    (FsInfo.version) with the cached one and re-reads on change.
 *  - Writes are conditional (`createIfAbsent` / `replaceIfVersion`). A write
 *    that loses a race re-reads the file and replays the mutation on the fresh
 *    board, so concurrent writers never drop each other's changes.
 *  - A corrupt, unsupported or pre-migration file is overwritten only after
 *    its backup copy was written; if the backup fails the board is read-only.
 *  - Operations on one workspace are serialized.
 *
 * The filesystem is the harness `fs` service (FileSystem from dsh-fs). With
 * dsh-ssh it routes the workspace path to the workspace's SSH connection.
 */
import { cloneBoard, emptyBoard, parseBoardText, SCHEMA_VERSION } from './core.js'

export const BOARD_FILE = '.dsh-kanban-flow.json'

/** Write attempts per mutation before a persistent conflict is reported. */
const MAX_WRITE_ATTEMPTS = 3

/** Raised when the board file cannot be loaded or must not be written. */
export class BoardUnavailableError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'BoardUnavailableError'
    this.code = 'BOARD_UNAVAILABLE'
  }
}

const errText = (err) => String((err && err.message) || err)
const isConflict = (err) => !!err && (err.code === 'FS_STALE_VERSION' || err.code === 'FS_NOT_OBSERVED')
const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * @param {object} deps
 * @param {() => any} deps.getFs - current FileSystem service, or undefined (memory-only mode).
 * @param {(workspace: any, session?: any) => any} deps.writePolicyFor - sandbox policy for writes.
 * @param {(workspace: any) => string} deps.initialCode - board code for a new board.
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.revalidateMs] - minimum interval between version checks for reads.
 * @param {() => number} [deps.now]
 */
export function createBoardStore(deps) {
  const log = deps.log || ((line) => console.log('dsh-kanban-flow: ' + line))
  const now = deps.now || Date.now
  const revalidateMs = typeof deps.revalidateMs === 'number' ? deps.revalidateMs : 1000
  const entries = new Map()

  const keyOf = (workspace) => String(workspace.id || workspace.workspaceId || workspace.path)

  const entryOf = (workspace) => {
    const key = keyOf(workspace)
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        key,
        board: null, // last good board; null until the first successful load
        target: undefined, // FsTarget once resolved; null in memory-only mode
        version: undefined, // FsVersion of the loaded file; null when the file is absent
        checkedAt: 0,
        blocked: null, // reason mutations are refused (read-only board)
        stale: false, // serving the last good board while the file is unreachable
        warnings: [],
        chain: Promise.resolve(),
      }
      entries.set(key, entry)
    }
    return entry
  }

  const serialized = (entry, fn) => {
    const run = entry.chain.then(fn, fn)
    entry.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const warn = (entry, message) => {
    entry.warnings.push(message)
    log(message)
  }

  const takeWarnings = (entry) => {
    const out = entry.warnings
    entry.warnings = []
    return out
  }

  const fileText = (board) => JSON.stringify({ ...cloneBoard(board), schemaVersion: SCHEMA_VERSION })

  const backup = async (fs, workspace, session, text, suffix) => {
    const target = await fs.resolve(BOARD_FILE + '.' + suffix, { cwd: workspace.path })
    await fs.writeText(target, text, undefined, undefined, deps.writePolicyFor(workspace, session))
  }

  /** Resolve the board file target; failures are not cached. */
  const targetOf = async (fs, workspace, entry) => {
    if (entry.target) return entry.target
    try {
      entry.target = await fs.resolve(BOARD_FILE, { cwd: workspace.path })
    } catch (err) {
      throw new BoardUnavailableError('Board file location unavailable for ' + workspace.path + ': ' + errText(err), { cause: err })
    }
    return entry.target
  }

  /**
   * Bring the entry up to date with the file. Throws BoardUnavailableError
   * when the file state cannot be determined; the entry keeps its last good
   * board in that case.
   */
  const refresh = async (workspace, session, entry, force) => {
    const fs = deps.getFs()
    if (!fs) {
      // Memory-only mode (no fs service): nothing to persist or re-read.
      entry.target = null
      if (!entry.board) entry.board = emptyBoard(deps.initialCode(workspace))
      return
    }
    if (!force && entry.board && entry.version !== undefined && now() - entry.checkedAt < revalidateMs) return
    const target = await targetOf(fs, workspace, entry)
    let info
    try {
      info = await fs.stat(target)
    } catch (err) {
      throw new BoardUnavailableError('Board file unreachable: ' + errText(err), { cause: err })
    }
    if (info !== undefined && info.type !== 'file') {
      throw new BoardUnavailableError('Board file path is not a regular file: ' + target.displayPath)
    }
    if (info === undefined) {
      // Absent file: a new board (or the file was deleted outside dsh).
      if (!entry.board || entry.version !== null) {
        if (entry.board && entry.version) warn(entry, 'Board file was removed outside dsh; the board was reset.')
        entry.board = emptyBoard(deps.initialCode(workspace))
        entry.blocked = null
      }
      entry.version = null
      entry.checkedAt = now()
      return
    }
    if (entry.board && entry.version === info.version) {
      entry.checkedAt = now()
      return
    }
    let text
    try {
      text = await fs.readText(target)
    } catch (err) {
      throw new BoardUnavailableError('Board file could not be read: ' + errText(err), { cause: err })
    }
    const parsed = parseBoardText(text)
    for (const w of parsed.warnings) warn(entry, w)
    entry.blocked = null
    if (parsed.ok) {
      entry.board = parsed.data
      entry.version = info.version
      entry.checkedAt = now()
      if (parsed.migrated) {
        try {
          await backup(fs, workspace, session, text, 'bak-v' + parsed.fromVersion)
        } catch (err) {
          entry.blocked = 'the pre-upgrade backup could not be written (' + errText(err) + ')'
          warn(entry, 'Board is read-only: ' + entry.blocked + '.')
          return
        }
        await writeEntry(fs, workspace, session, entry, entry.board).catch((err) => {
          // The file keeps its old schema; the next successful mutation writes the upgraded board.
          log('upgraded board could not be saved: ' + errText(err))
        })
      }
      return
    }
    // Corrupt / invalid / newer schema: keep a copy before the board may be replaced.
    const suffix = parsed.kind === 'unsupported' ? 'unsupported-v' + parsed.version : 'corrupt-' + timestamp()
    entry.board = emptyBoard(deps.initialCode(workspace))
    entry.version = info.version
    entry.checkedAt = now()
    try {
      await backup(fs, workspace, session, text, suffix)
    } catch (err) {
      entry.blocked = 'the unreadable board file could not be backed up (' + errText(err) + ')'
      warn(entry, 'Board is read-only: ' + entry.blocked + '.')
    }
  }

  /** Conditional write of `board`; updates the entry only after success. */
  const writeEntry = async (fs, workspace, session, entry, board) => {
    const expected = entry.version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: entry.version }
    const outcome = await fs.writeText(entry.target, fileText(board), expected, undefined, deps.writePolicyFor(workspace, session))
    entry.board = board
    entry.version = outcome && outcome.version !== undefined ? outcome.version : undefined
    entry.checkedAt = now()
  }

  /**
   * Read the current board.
   * @returns {Promise<{ board: any, persisted: boolean, stale: boolean, warnings: string[] }>}
   * @throws {BoardUnavailableError} when no board was ever loaded and the file is unavailable.
   */
  const read = (workspace, session) => {
    const entry = entryOf(workspace)
    return serialized(entry, async () => {
      try {
        await refresh(workspace, session, entry, false)
        entry.stale = false
      } catch (err) {
        if (!(err instanceof BoardUnavailableError) || !entry.board) throw err
        // Warn once per outage; `stale` stays set on every read until the file is reachable.
        if (!entry.stale) warn(entry, err.message + ' Showing the last loaded board; changes are disabled until it is reachable.')
        entry.stale = true
      }
      return { board: entry.board, persisted: entry.target !== null && entry.target !== undefined, stale: entry.stale, warnings: takeWarnings(entry) }
    })
  }

  /**
   * Apply a mutation and persist it. `apply` receives a private copy of the
   * fresh board and returns an op result; `{ error }` aborts without writing.
   * It may run more than once (replayed after a write conflict).
   * @returns {Promise<{ result: any, board: any, persisted: boolean, warnings: string[] }>}
   * @throws {BoardUnavailableError} when the board cannot be loaded, is read-only, or the write fails.
   */
  const mutate = (workspace, session, apply) => {
    const entry = entryOf(workspace)
    return serialized(entry, async () => {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        await refresh(workspace, session, entry, true)
        if (entry.blocked) throw new BoardUnavailableError('Board is read-only: ' + entry.blocked + '.')
        const draft = structuredClone(entry.board)
        const result = apply(draft)
        if (result && result.error) return { result, board: entry.board, persisted: entry.target !== null, warnings: takeWarnings(entry) }
        const fs = deps.getFs()
        if (!fs || entry.target === null) {
          entry.board = draft
          return { result, board: entry.board, persisted: false, warnings: takeWarnings(entry) }
        }
        try {
          await writeEntry(fs, workspace, session, entry, draft)
          return { result, board: entry.board, persisted: true, warnings: takeWarnings(entry) }
        } catch (err) {
          if (isConflict(err)) {
            log('board changed during write (' + entry.key + '), retrying: ' + errText(err))
            entry.version = undefined // force a re-read on the next attempt
            continue
          }
          throw new BoardUnavailableError('Board could not be saved: ' + errText(err), { cause: err })
        }
      }
      throw new BoardUnavailableError('Board could not be saved: the file kept changing during the write; try again.')
    })
  }

  /** Drop cached state (e.g. when a workspace is removed). */
  const forget = (workspace) => {
    entries.delete(keyOf(workspace))
  }

  return { read, mutate, forget, keyOf }
}
