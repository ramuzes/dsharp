/**
 * Browser-half contract tests (Task 9).
 *
 * client.js is one self-contained script in the client module system's factory
 * format, so the suite boots it against a stub __ModuleLoader__, feeds the
 * factory a stub require (fake React only — the card is hand-rolled markup
 * with no @deepseek-ai/dsh-client-ui-* import, per repo rule), and exercises
 * the returned cordis plugin: dictionary registration, the `plugins.bundle.config`
 * slot entry keyed by the bundle id, the staged-form flow over the row's
 * config form, and disposer removal of both registrations.
 *
 * Fakes mirror real strictness (AGENTS.md): the ctx exposes ONLY the injected
 * service names (any other property access throws, like cordis "cannot get
 * property ... without inject"), and the config form scope carries the real
 * SettingsFormScope shape (status/value/base/user/writable/revision + mutate).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Capture the load() registration the script performs on import. */
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
await import('../client.js')

/**
 * Fake React: vdom-building createElement plus the hook subset the body uses.
 * Hook state lives in the harness, so one harness == one component instance.
 */
function createHarness() {
  const hooks = []
  let cursor = 0
  const pending = []
  let last
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const slot = hooks[cursor] ??= { value: typeof initial === 'function' ? initial() : initial }
      cursor += 1
      const setState = (update) => { slot.value = typeof update === 'function' ? update(slot.value) : update }
      return [slot.value, setState]
    },
    useEffect(effect, deps) {
      const slot = hooks[cursor] ??= { hasRun: false, deps: undefined, cleanup: undefined }
      cursor += 1
      const same = slot.hasRun && deps !== undefined
        && deps.length === (slot.deps?.length ?? 0)
        && deps.every((dep, index) => Object.is(dep, slot.deps[index]))
      if (!same) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        pending.push(() => { slot.cleanup = effect() ?? undefined })
      }
      slot.hasRun = true
      slot.deps = deps
    },
    useMemo(factory, deps) {
      const slot = hooks[cursor] ??= { initialized: false, value: undefined, deps: undefined }
      cursor += 1
      const same = slot.initialized && deps !== undefined
        && deps.every((dep, index) => Object.is(dep, slot.deps[index]))
      if (!same) { slot.value = factory(); slot.deps = deps; slot.initialized = true }
      return slot.value
    },
    useCallback(factory, deps) {
      return React.useMemo(() => factory, deps)
    },
    Fragment: 'fragment',
  }
  return {
    React,
    render(component, props) {
      last = { component, props }
      cursor = 0
      pending.length = 0
      return component(props)
    },
    rerender() { return last === undefined ? undefined : this.render(last.component, last.props) },
    flush() { pending.splice(0).forEach((effect) => { effect() }) },
    async settle(rounds = 4) {
      for (let round = 0; round < rounds; round += 1) {
        this.flush()
        await new Promise((resolve) => setImmediate(resolve))
        this.rerender()
      }
      this.flush()
    },
  }
}

/** All string children of a vdom subtree, in order. */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node !== 'object') { out.push(String(node)); return out }
  for (const child of node.children ?? []) texts(child, out)
  return out
}

/** First node in the subtree satisfying the predicate. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/** A translating t that prefixes keys. */
function makeT() {
  return (key) => `t:${key}`
}

/** A config form scope double carrying the real SettingsFormScope shape. */
function makeScope(initial = {}) {
  const snapshot = {
    status: 'ready',
    value: { ...initial },
    base: {},
    user: {},
    writable: true,
    revision: 7,
  }
  const calls = { mutates: [], subscribers: 0 }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => { calls.subscribers += 1; return () => {} },
    mutate: async (ops, revision) => {
      calls.mutates.push({ ops, revision })
      for (const op of ops) {
        if (op.op === 'set') snapshot.value[op.path[0]] = op.value
        else delete snapshot.value[op.path[0]]
      }
      snapshot.user = { ...snapshot.user }
      return true
    },
  }
  return { scope, calls, snapshot }
}

/** Boot the browser plugin against a fresh harness and ctx. */
function bootPlugin({ scope, credentials } = {}) {
  const harness = createHarness()
  const form = scope ?? makeScope().scope
  const recorded = { namespaces: [], injects: [], registers: [], disposers: [] }
  // Fake credentials Remote (the client side of ctx.remote.credentials):
  // records set/describe; describe answers from the per-boot map so the
  // Configured/Not-set badge has real input. Mirrors the real shape —
  // set(ref, value) and describe(refs) → Record<ref, { configured }>.
  const secretApi = {
    setCalls: [],
    describeCalls: [],
    store: credentials ?? {},
    set: async (ref, value) => { secretApi.setCalls.push([ref, value]); secretApi.store[ref] = value },
    describe: async (refs) => {
      secretApi.describeCalls.push([...refs])
      return Object.fromEntries(refs.map((ref) => [ref, { configured: ref in secretApi.store, writable: true }]))
    },
  }
  const ctx = new Proxy({
    effect(fn) {
      const disposer = fn()
      recorded.disposers.push(disposer)
      return disposer
    },
    locale: {
      register: (ns, dicts) => {
        recorded.namespaces.push({ ns, dicts })
        return () => { recorded.namespaces = recorded.namespaces.filter((entry) => entry.ns !== ns) }
      },
    },
    configForms: { get: () => form },
    remote: { credentials: secretApi },
    slots: {
      inject: (name, begin) => {
        recorded.injects.push(name)
        return begin()
      },
      register: (declaration, Component) => {
        recorded.registers.push({ declaration, Component })
        return () => { recorded.registers.length = 0 }
      },
    },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
  const plugin = loaded[0].factory((specifier) => {
    if (specifier === 'react') return harness.React
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { harness, ctx, recorded, plugin, form, secretApi }
}

/** Flat key list of a locale dictionary, for zh/en parity. */
function keysOf(dict) {
  return Object.keys(dict).sort()
}

test('client.js exposes the factory-format plugin with the documented inject list', () => {
  const entry = loaded[0]
  assert.equal(entry.id, 'dsh-engram')
  const plugin = entry.factory(() => ({ createElement: () => null })) // react is the only module
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms', 'remote'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the engram dictionary with zh and en of equal shape', () => {
  const { ctx, recorded, plugin } = bootPlugin()
  plugin.apply(ctx)
  assert.equal(recorded.namespaces.length, 1)
  const { ns, dicts } = recorded.namespaces[0]
  assert.equal(ns, 'engram')
  assert.equal(typeof dicts.zh, 'object')
  assert.equal(typeof dicts.en, 'object')
  assert.deepEqual(keysOf(dicts.zh), keysOf(dicts.en))
  assert.ok(keysOf(dicts.en).includes('config.summary'))
  // Group labels for the four card groups the spec names.
  for (const key of ['group.daemon', 'group.project', 'group.injection', 'group.cloud']) {
    assert.ok(keysOf(dicts.en).includes(key), `missing ${key}`)
  }
})

test('apply registers exactly one plugins.bundle.config slot entry keyed by the bundle id', () => {
  const { ctx, recorded, plugin } = bootPlugin()
  plugin.apply(ctx)
  assert.deepEqual(recorded.injects, ['plugins.bundle.config'])
  assert.equal(recorded.registers.length, 1)
  const { declaration, Component } = recorded.registers[0]
  assert.equal(declaration.name, 'plugins.bundle.config')
  assert.equal(declaration.key, 'dsh-engram')
  assert.equal(declaration.locale, 'engram')
  assert.equal(typeof declaration.inject, 'function')
  assert.equal(typeof Component, 'function')
})

test('dispose removes both the dictionary and the slot entry', () => {
  const { ctx, recorded, plugin } = bootPlugin()
  plugin.apply(ctx)
  assert.equal(recorded.namespaces.length, 1)
  assert.equal(recorded.registers.length, 1)
  for (const disposer of recorded.disposers) disposer?.()
  assert.equal(recorded.namespaces.length, 0)
  assert.equal(recorded.registers.length, 0)
})

test('slot face exposes the config snapshot hook and the staged-form actions', () => {
  const scope = makeScope({ port: '7437', autosync: true })
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  assert.equal(typeof face.hooks.config.getSnapshot, 'function')
  assert.equal(typeof face.hooks.config.subscribe, 'function')
  assert.equal(typeof face.edit, 'function')
  assert.equal(typeof face.resetField, 'function')
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.discard, 'function')
  const snapshot = face.hooks.config.getSnapshot()
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.writable, true)
  assert.equal(snapshot.port.text, '7437')
  assert.equal(snapshot.autosync.text, 'true')
  // getSnapshot must return the SAME object between notifications (React #185).
  assert.equal(face.hooks.config.getSnapshot(), snapshot)
})

test('staged edits save through one revision-fenced mutate', async () => {
  const scope = makeScope({ contextMaxBytes: 2048 })
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  face.edit('port', '9999')
  face.edit('contextMaxBytes', '4096')
  const dirty = face.hooks.config.getSnapshot()
  assert.equal(dirty.dirty, true)
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scope.calls.mutates.length, 1)
  const { ops, revision } = scope.calls.mutates[0]
  // The revision the drafts were staged against fences the write.
  assert.equal(revision, 7)
  assert.deepEqual(ops, [
    { op: 'set', path: ['port'], value: '9999' },
    { op: 'set', path: ['contextMaxBytes'], value: 4096 },
  ])
})

test('an invalid draft marks its field invalid and blocks the save', async () => {
  const scope = makeScope({})
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  face.edit('contextMaxBytes', 'not-a-number')
  const snapshot = face.hooks.config.getSnapshot()
  assert.equal(snapshot.contextMaxBytes.invalid, true)
  assert.equal(snapshot.invalid, true)
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scope.calls.mutates.length, 0)
  // An illegal enum draft blocks the same way.
  const scope2 = makeScope({})
  const boot2 = bootPlugin({ scope: scope2.scope })
  boot2.plugin.apply(boot2.ctx)
  const face2 = boot2.recorded.registers[0].declaration.inject()
  face2.edit('daemonMode', 'cluster')
  assert.equal(face2.hooks.config.getSnapshot().daemonMode.invalid, true)
  await face2.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scope2.calls.mutates.length, 0)
})

test('projectMap stages name=project pairs and an empty draft clears', async () => {
  const scope = makeScope({ projectMap: { web: 'proj-web' } })
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  assert.equal(face.hooks.config.getSnapshot().projectMap.text, 'web=proj-web')
  face.edit('projectMap', 'web=proj-web\ncli=proj-cli')
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(scope.snapshot.value.projectMap, { web: 'proj-web', cli: 'proj-cli' })
  // Empty draft → unset (re-inherit the schema default {}).
  face.edit('projectMap', '')
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  const lastOp = scope.calls.mutates.at(-1).ops
  assert.deepEqual(lastOp, [{ op: 'unset', path: ['projectMap'] }])
})

test('a malformed projectMap draft blocks the save', async () => {
  const scope = makeScope({})
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  face.edit('projectMap', 'web=proj-web\nno-separator')
  assert.equal(face.hooks.config.getSnapshot().projectMap.invalid, true)
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scope.calls.mutates.length, 0)
})

test('discard drops every staged edit without writing', async () => {
  const scope = makeScope({})
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  // React reads through a live uSES subscription; subscribe like it does so
  // notifications invalidate the memoized snapshot.
  const off = face.hooks.config.subscribe(() => {})
  face.edit('port', '9999')
  assert.equal(face.hooks.config.getSnapshot().dirty, true)
  face.discard()
  assert.equal(face.hooks.config.getSnapshot().dirty, false)
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scope.calls.mutates.length, 0)
})

test('resetField stages a clear so the field re-inherits the composition layer', async () => {
  const scope = makeScope({ port: '9999' })
  scope.scope.getSnapshot().user = { port: '9999' }
  const { ctx, recorded, plugin } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  assert.equal(face.hooks.config.getSnapshot().port.overridden, true)
  face.resetField('port')
  assert.equal(face.hooks.config.getSnapshot().port.text, '9999') // staged clear shows base text
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(scope.calls.mutates.at(-1).ops, [{ op: 'unset', path: ['port'] }])
})

test('the card renders grouped sections and a summary line', () => {
  const scope = makeScope({})
  const { ctx, recorded, plugin, harness } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const { declaration, Component } = recorded.registers[0]
  const face = declaration.inject()
  const useConfig = (selector) => selector(face.hooks.config.getSnapshot())
  const props = { view: 'page', t: makeT(), useConfig, ...face }
  const tree = harness.render(Component, props)
  const rendered = texts(tree).join(' ')
  for (const key of ['group.daemon', 'group.project', 'group.injection', 'group.cloud']) {
    assert.ok(rendered.includes(`t:${key}`), `card should render ${key}`)
  }
  // Summary view renders the one-liner alone.
  const summary = harness.render(Component, { ...props, view: 'summary' })
  assert.equal(texts(summary).join(' '), 't:config.summary')
})

test('an unavailable namespace renders the unavailable line in place of the controls', () => {
  const scope = makeScope({})
  scope.scope.getSnapshot().status = 'unavailable'
  const { ctx, recorded, plugin, harness } = bootPlugin({ scope: scope.scope })
  plugin.apply(ctx)
  const { declaration, Component } = recorded.registers[0]
  const face = declaration.inject()
  const tree = harness.render(Component, {
    view: 'page', t: makeT(), useConfig: (selector) => selector(face.hooks.config.getSnapshot()), ...face,
  })
  assert.ok(texts(tree).join(' ').includes('t:config.unavailable'))
})

test('classes are engram-prefixed and styles ride a plugin-tagged style element', () => {
  const scope = makeScope({})
  const { ctx, recorded, plugin, harness } = bootPlugin({ scope: scope.scope })
  const heads = []
  globalThis.document = {
    createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
    head: { append: (node) => heads.push(node) },
  }
  try {
    plugin.apply(ctx)
    const { declaration, Component } = recorded.registers[0]
    const face = declaration.inject()
    const tree = harness.render(Component, {
      view: 'page', t: makeT(), useConfig: (selector) => selector(face.hooks.config.getSnapshot()), ...face,
    })
    const classNames = findAll(tree, (node) => typeof node.props?.className === 'string')
      .map((node) => node.props.className)
    assert.ok(classNames.length > 0)
    for (const className of classNames.flat()) {
      for (const name of className.split(' ')) {
        if (name === '') continue
        assert.ok(name.startsWith('engram-'), `class ${name} is not engram-prefixed`)
      }
    }
    assert.equal(heads.length, 1)
    assert.equal(heads[0].dataset.plugin, 'dsh-engram')
    assert.ok(heads[0].textContent.includes('engram-'))
    assert.ok(!heads[0].textContent.includes('dsh-client-ui'))
  } finally {
    delete globalThis.document
  }
})

// ---- credentials-backed secret control (the feishu SettingsSecretField pattern) ----

test('a staged secret saves through the credentials Remote under the live ref name', async () => {
  const { ctx, recorded, plugin, secretApi } = bootPlugin()
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  face.edit('httpToken', 'tok-secret-1')
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(secretApi.setCalls, [['ENGRAM_HTTP_TOKEN', 'tok-secret-1']])
  // No config op rides along: the secret never becomes a patch-layer value.
  assert.equal(face.hooks.config.getSnapshot().httpToken.text, '')
})

test('a blank staged secret is a no-op — blank saves never clobber the stored value', async () => {
  const { ctx, recorded, plugin, secretApi } = bootPlugin({ credentials: { ENGRAM_HTTP_TOKEN: 'kept' } })
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  face.edit('httpToken', '   ')
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(secretApi.setCalls, [])
  assert.equal(secretApi.store.ENGRAM_HTTP_TOKEN, 'kept')
})

test('the Configured badge follows describe and refreshes after a save', async () => {
  const { ctx, recorded, plugin, secretApi } = bootPlugin()
  plugin.apply(ctx)
  const face = recorded.registers[0].declaration.inject()
  // The real card subscribes (React), which is what invalidates the snapshot
  // cache; mirror that so badge updates are observable here.
  const unsubscribe = face.hooks.config.subscribe(() => {})
  await new Promise((resolve) => setImmediate(resolve)) // initial refreshSecrets
  assert.equal(face.hooks.config.getSnapshot().httpToken.configured, false)
  face.edit('httpToken', 'tok-secret-2')
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const state = face.hooks.config.getSnapshot().httpToken
  assert.equal(state.configured, true, 'badge flips after the save lands')
  assert.deepEqual(secretApi.describeCalls.at(-1), ['ENGRAM_HTTP_TOKEN'])
  unsubscribe()
})
