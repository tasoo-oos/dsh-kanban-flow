/**
 * dsh-kanban-flow — cross-workspace overview (pure; no cordis, no I/O).
 *
 * Turns per-workspace board snapshots into the compact rows the global
 * "Boards" panel renders: every open item plus the most recent Done items,
 * each with its latest activity, instead of whole boards and activity logs.
 */
import { COLUMN_IDS } from './core.js'

/** Done items kept per workspace in the overview (most recently active first). */
export const OVERVIEW_DONE_LIMIT = 10

/** Latest activity per item id, from an append-only activity log. */
export function latestActivities(activities) {
  const last = new Map()
  for (const a of Array.isArray(activities) ? activities : []) {
    if (a && typeof a.itemId === 'string') last.set(a.itemId, a)
  }
  return last
}

const activityTime = (a) => {
  const t = a && typeof a.ts === 'string' ? Date.parse(a.ts) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * Overview row of one loaded board.
 * @param {{ id: string, path: string, title?: string }} workspace
 * @param {{ board: any, stale?: boolean }} snap - store read result.
 */
export function boardOverview(workspace, snap) {
  const board = snap.board
  const last = latestActivities(board.activities)
  const counts = Object.fromEntries(COLUMN_IDS.map((id) => [id, 0]))
  const open = []
  const done = []
  for (const item of board.items) {
    if (counts[item.columnId] !== undefined) counts[item.columnId] += 1
    const a = last.get(item.id)
    const row = {
      id: item.id,
      columnId: item.columnId,
      name: item.name,
      description: item.description || '',
      sessionId: item.sessionId || null,
      createdAt: item.createdAt || null,
      createdBy: item.createdBy,
      statusNote: item.statusNote || null,
      statusAt: item.statusAt || null,
      lastActivity: a ? { type: a.type, source: a.source, from: a.from || null, to: a.to || null, ts: a.ts } : null,
    }
    if (item.columnId === 'done') done.push(row)
    else open.push(row)
  }
  done.sort((x, y) => activityTime(y.lastActivity) - activityTime(x.lastActivity))
  return {
    workspaceId: String(workspace.id),
    title: workspace.title || workspace.path,
    path: workspace.path,
    ok: true,
    stale: snap.stale === true,
    code: board.code,
    confirmRequired: !!(board.settings && board.settings.confirmRequired),
    counts,
    doneHidden: Math.max(0, done.length - OVERVIEW_DONE_LIMIT),
    items: [...open, ...done.slice(0, OVERVIEW_DONE_LIMIT)],
  }
}

/** Overview row of a workspace whose board could not be loaded. */
export function unavailableOverview(workspace, error) {
  return {
    workspaceId: String(workspace.id),
    title: workspace.title || workspace.path,
    path: workspace.path,
    ok: false,
    error: String(error),
    items: [],
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep input order.
 */
export async function mapLimited(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next
      next += 1
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/** Reject with `message` when `promise` does not settle within `ms`. */
export function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
