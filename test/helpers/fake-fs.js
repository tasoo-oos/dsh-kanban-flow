/** In-memory FileSystem double with versions, write intents and fault injection. */
export function fakeFs() {
  const files = new Map()
  let counter = 0
  const fail = { resolve: null, stat: null, read: null, write: null, writeMatch: null }
  const take = (name) => {
    const err = fail[name]
    if (err && err.once) fail[name] = null
    return err
  }
  const fsError = (code, message) => Object.assign(new Error(message), { code })
  const put = (key, text) => {
    counter += 1
    const version = 'v' + counter
    files.set(key, { text, version })
    return version
  }
  return {
    files,
    fail,
    put,
    async resolve(path, opts) {
      const err = take('resolve')
      if (err) throw err
      const key = (opts && opts.cwd ? opts.cwd + '/' : '') + path
      return { targetKey: key, displayPath: key }
    },
    async stat(target) {
      const err = take('stat')
      if (err) throw err
      const f = files.get(target.targetKey)
      return f ? { type: 'file', version: f.version, size: f.text.length } : undefined
    },
    async readText(target) {
      const err = take('read')
      if (err) throw err
      const f = files.get(target.targetKey)
      if (!f) throw fsError('FS_NOT_FOUND', 'not found')
      return f.text
    },
    async writeText(target, text, expected) {
      if (!fail.writeMatch || fail.writeMatch.test(target.targetKey)) {
        const err = take('write')
        if (err) throw err
      }
      const existing = files.get(target.targetKey)
      if (expected && expected.kind === 'createIfAbsent' && existing) throw fsError('FS_NOT_OBSERVED', 'exists')
      if (expected && expected.kind === 'replaceIfVersion' && (!existing || existing.version !== expected.version)) {
        throw fsError('FS_STALE_VERSION', 'stale')
      }
      const version = put(target.targetKey, text)
      return { operation: existing ? 'update' : 'create', version, before: existing ? existing.text : null, after: text }
    },
  }
}
