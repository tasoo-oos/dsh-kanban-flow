import { describe, expect, it } from 'vitest'
import { KanbanFlowPlugin } from '../src/client/plugin'

/**
 * Regression test for the dsh 0.1.5-rc.3 breakage (2026-09-26): apply() did a
 * one-shot ctx.get("workspaces") / ctx.get("sessions") while the module only
 * declared inject: ["slots"]. On hosts where those client services register
 * after third-party applies run, the one-shot get returns undefined forever —
 * the plugin mounts but every workspace lookup silently returns null (no
 * sidebar buttons, empty board). Cordis delays apply() until every entry of
 * inject exists, so every service consumed via ctx.get() inside apply() MUST
 * be declared in inject.
 */

/** Service names consumed via ctx.get("...") inside apply()'s source. */
function consumedServices(source) {
  const consumed = new Set()
  let idx = 0
  while ((idx = source.indexOf('ctx.get(', idx)) !== -1) {
    const rest = source.slice(idx + 'ctx.get('.length).trim()
    const m = rest.match(/^["']([a-zA-Z][\w.-]*)["']/)
    if (m) consumed.add(m[1])
    idx += 'ctx.get('.length
  }
  return consumed
}

describe('KanbanFlowPlugin dependency contract', () => {
  it('declares every ctx.get() service of apply() in inject', () => {
    const consumed = consumedServices(String(KanbanFlowPlugin.apply))
    expect(consumed.size).toBeGreaterThan(0)
    const missing = [...consumed].filter((name) => !KanbanFlowPlugin.inject.includes(name))
    expect(missing).toEqual([])
  })

  it('still registers all three UI slots when services are present', () => {
    const registered = []
    const slots = {
      inject: (name, register) => {
        registered.push(name)
        register()
      },
      register: () => () => null,
    }
    const ctx = {
      get: (name) =>
        name === 'slots'
          ? slots
          : name === 'workspaces'
            ? { list: { getSnapshot: () => ({ items: [] }) } }
            : { bindings: {} },
      effect: () => () => undefined,
    }
    KanbanFlowPlugin.apply(ctx)
    expect(registered.sort()).toEqual(['conversation.view', 'settings.plugins.tab', 'sidebar.footer.action'])
  })
})
