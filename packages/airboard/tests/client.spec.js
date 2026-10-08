/**
 * Browser-half contract tests.
 *
 * client.js is one self-contained script in the client module system's factory
 * format, so the suite boots it against a stub __ModuleLoader__, feeds the
 * factory a stub require (fake React + primitives), and exercises the returned
 * cordis plugin: its registration surface, and the tab body's data flow through
 * a tiny hook harness with a stubbed same-origin fetch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Capture the load() registration the script performs on import. */
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
await import('../client.js')

/** Marker component standing in for the shared markdown renderer. */
function MarkdownText(props) { return null }

/** Marker for the refresh icon primitive. */
function IconRefreshOutlineRegular(props) { return null }

/** Marker components standing in for the shared staged-form chrome. */
function SettingsForm(props) { return { type: 'settings-form', props } }
function SettingsValueField(props) { return { type: 'settings-value-field', props } }
function SettingsSecretField(props) { return { type: 'settings-secret-field', props } }

/**
 * A fake SettingsFormModel over a stub scope: stage per field, project the
 * shell, and forward secret writes to the scope's set() — enough contract for
 * the card tests.
 */
class FakeFormModel {
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.secrets = new Map(secrets.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.disposed = false
  }
  bind(project) {
    this.project = project
    return { getSnapshot: () => project(), subscribe: () => () => {} }
  }
  shell() {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid: false,
      saving: false,
      failed: false,
    }
  }
  field(name) {
    const snapshot = this.scope.getSnapshot()
    const accepted = this.specs.get(name) !== undefined
      ? (this.specs.get(name).format(snapshot.value?.[name])) : ''
    const staged = this.staged.get(name)
    return {
      text: staged === undefined ? accepted : staged,
      overridden: snapshot.user !== null && typeof snapshot.user === 'object' && snapshot.user[name] !== undefined,
      invalid: false,
    }
  }
  actions() {
    return {
      edit: (field, text) => { this.staged.set(field, text) },
      resetField: (field) => { this.staged.delete(field) },
      save: () => {},
      discard: () => { this.staged.clear() },
    }
  }
  dispose() { this.disposed = true }
}

/** The primitives module the factory's require hands out. */
function primitives() {
  return {
    MarkdownText, IconRefreshOutlineRegular,
    SettingsForm, SettingsValueField, SettingsSecretField,
    SettingsFormModel: FakeFormModel, settingsTextField: (field) => ({ field, format: (value) => (typeof value === 'string' ? value : '') }),
  }
}

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
        // React runs the previous effect's cleanup before the effect re-runs.
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
  }
  return {
    React,
    /** One render pass: fresh hook cursor, fresh effect queue. */
    render(component, props) {
      last = { component, props }
      cursor = 0
      pending.length = 0
      return component(props)
    },
    /** Re-run the last render, as React would after a state change. */
    rerender() { return last === undefined ? undefined : this.render(last.component, last.props) },
    /** Run the effects recorded by the last render. */
    flush() { pending.splice(0).forEach((effect) => { effect() }) },
    /** Flush, re-render, and repeat so state changes schedule their effects. */
    async settle(rounds = 6) {
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

/** A translating t that prefixes keys and fills {params}. */
function makeT() {
  return (key, params) => `t:${key}`.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

/** Boot the browser plugin against a fresh harness. */
function bootPlugin() {
  const harness = createHarness()
  const require = (specifier) => {
    if (specifier === 'react') return harness.React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives()
    throw new Error(`unexpected require: ${specifier}`)
  }
  return { harness, plugin: loaded[0].factory(require) }
}

/** A cordis ctx double recording every registration the plugin makes. */
function makeCtx({ configForm, describe } = {}) {
  const recorded = { tabs: [], injects: [], registers: [], namespaces: [] }
  const ctx = {
    effect(fn) { return fn() ?? undefined },
    locale: {
      bind: () => makeT(),
      register: (ns, dicts) => { recorded.namespaces.push({ ns, dicts }) },
    },
    sidebarRightTabs: { register: (definition) => { recorded.tabs.push(definition); return () => {} } },
    configForms: {
      get: (entryId) => configForm ?? {
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 0, value: {}, user: {} }),
        subscribe: () => () => {},
        mutate: () => Promise.resolve(true),
        set: () => Promise.resolve(true),
      },
      describe: () => describe ?? { getSnapshot: () => ({ view: { namespaces: [] } }) },
    },
    slots: {
      inject: (name, begin) => { recorded.injects.push(name); return begin() },
      register: (declaration, Component) => { recorded.registers.push({ declaration, Component }); return () => {} },
    },
  }
  return [ctx, recorded]
}

/** Install a document double around a callback. */
function withDocument(double, run) {
  const previous = globalThis.document
  globalThis.document = double
  try {
    return run()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

/** Flat key list of a locale dictionary, for zh/en parity. */
function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, inner]) => (
    typeof inner === 'object' && inner !== null ? keys(inner, `${prefix}${key}.`) : [`${prefix}${key}`]
  )).sort()
}

/** Render the tab body against a fetch stub this test controls. */
async function renderBody(routes) {
  const calls = []
  const signals = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    calls.push(text)
    signals.push({ url: text, signal: init?.signal })
    const route = routes[text]
    if (route === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: text } }) }
    }
    if (route.throw !== undefined) throw route.throw
    return { ok: route.status === undefined || route.status < 400, status: route.status ?? 200, json: async () => route.body }
  }
  const { harness, plugin } = bootPlugin()
  const [ctx, recorded] = makeCtx()
  withDocument(
    { createElement: () => ({ dataset: {}, textContent: '', remove() {} }), head: { append() {} } },
    () => plugin.apply(ctx),
  )
  const body = recorded.registers.find(({ declaration }) => declaration.name === 'sidebar.right.pane.tab').Component
  const commands = {}
  const props = {
    t: makeT(),
    useTabInfo: () => ({
      tab: {
        id: 'tab-1',
        navigation: { revision: 1 },
        actions: { bindCommands: (given) => { Object.assign(commands, given); return () => {} } },
      },
    }),
  }
  const view = { vdom: undefined, calls, signals, commands, harness }
  const render = () => { view.vdom = harness.render(body, props) }
  render()
  await harness.settle()
  render()
  /** Apply a gesture, let its fetch settle, and re-render into view.vdom. */
  view.interact = async (gesture) => {
    if (gesture !== undefined) gesture()
    await harness.settle()
    render()
    return view.vdom
  }
  return view
}

const RESOURCES = [
  { id: 'PRD-1', kind: 'PRD', number: 1, project_key: 'CORE', title: 'Quant product requirements', status: 'active', content_markdown: '# PRD\nRequirements **here**.', rev: 2, updated_at: '2026-10-01 10:00:00' },
  { id: 'ADR-2', kind: 'ADR', number: 2, project_key: 'CORE', title: 'Adopt SQLite', status: 'active', content_markdown: '# ADR-2\nBecause one file is enough.', rev: 1, updated_at: '2026-09-30 09:00:00' },
  { id: 'ADR-1', kind: 'ADR', number: 1, project_key: 'CORE', title: 'Use Fastify', status: 'done', content_markdown: '# ADR-1\nFast and strict.', rev: 3, updated_at: '2026-09-01 08:00:00' },
  { id: 'ISSUE-9', kind: 'ISSUE', number: 9, project_key: 'CORE', title: 'Fix login flow', status: 'cancelled', content_markdown: '# ISSUE-9\nCancelled.', rev: 1, updated_at: '2026-08-12 12:00:00' },
]

test('client.js registers one module named dsh-airboard in the factory format', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-airboard')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('the factory returns a plugin injecting the documented services only', () => {
  const { plugin } = bootPlugin()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs', 'configForms'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the tab type, the keyed body seat, dictionaries, and scoped styles', () => {
  const { plugin } = bootPlugin()
  const style = { dataset: {}, textContent: '', remove() { removed += 1 } }
  let removed = 0
  const appended = []
  const [ctx, recorded] = makeCtx()
  withDocument(
    { createElement: () => style, head: { append: (node) => appended.push(node) } },
    () => plugin.apply(ctx),
  )
  // Tab type: a page kind with a guide entry and keepMounted bodies.
  const [definition] = recorded.tabs
  assert.equal(definition.id, 'dsh-airboard')
  assert.equal(definition.kind, 'airboard')
  assert.equal(definition.keepMounted, true)
  assert.equal(definition.priority, 'extension')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'airboard')
  assert.equal(typeof definition.guide[0].title, 'function')
  assert.equal(typeof definition.guide[0].description, 'function')
  // Seats: the body under the keyed pane tab; no title seat (static chip).
  assert.ok(recorded.injects.includes('sidebar.right.pane.tab'))
  assert.ok(!recorded.injects.includes('sidebar.right.pane.tab.title'))
  const seat = recorded.registers.find(({ declaration }) => declaration.name === 'sidebar.right.pane.tab')
  assert.equal(seat.declaration.key, 'dsh-airboard')
  assert.equal(typeof seat.Component, 'function')
  // Dictionaries: one namespace, zh/en key parity.
  assert.equal(recorded.namespaces.length, 1)
  const { ns, dicts } = recorded.namespaces[0]
  assert.equal(ns, 'airboard')
  assert.deepEqual(keys(dicts.zh), keys(dicts.en))
  assert.ok(keys(dicts.zh).length >= 20)
  // Styles: injected once, scoped by attribute, removable.
  assert.equal(appended.length, 1)
  assert.match(style.textContent, /\[data-airboard/)
  style.remove()
  assert.equal(removed, 1)
})

/** The config card's seat and face, captured from a fresh apply. */
function bootConfigCard({ configForm, describe } = {}) {
  const { harness, plugin } = bootPlugin()
  const [ctx, recorded] = makeCtx({ configForm, describe })
  withDocument(
    { createElement: () => ({ dataset: {}, textContent: '', remove() {} }), head: { append() {} } },
    () => plugin.apply(ctx),
  )
  const seat = recorded.registers.find(({ declaration }) => declaration.name === 'plugins.bundle.config')
  assert.ok(seat, 'the bundle config card seat is registered')
  assert.equal(seat.declaration.key, 'dsh-airboard')
  return { harness, face: seat.declaration.inject(), Component: seat.Component, ctx }
}

test('apply registers the bundle config card over the shared staged-form model', () => {
  const setCalls = []
  const configForm = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: { baseUrl: 'http://ab.antaresy.cc' }, user: {} }),
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
    set: (field, value) => { setCalls.push({ field, value }); return Promise.resolve(true) },
  }
  const describe = { getSnapshot: () => ({ view: { namespaces: [{ ns: 'airboard', secrets: [{ path: ['token'], set: true }] }] } }) }
  const { face } = bootConfigCard({ configForm, describe })
  const bound = face
  // The face binds the model's store as a selector hook plus staged-form actions.
  assert.equal(typeof bound.hooks.config.getSnapshot, 'function')
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof bound[action], 'function', action)
  }
  // The projection derives the token's configured state from the describe sidecar.
  const state = bound.hooks.config.getSnapshot()
  assert.equal(state.tokenConfigured, true)
  assert.equal(state.available, true)
  assert.equal(state.baseUrl.text, 'http://ab.antaresy.cc')
})

test('the config card renders the shared chrome with both fields wired to the face', () => {
  const { harness, Component, face } = bootConfigCard()
  const bound = face
  const edits = []
  const props = {
    view: 'page',
    t: makeT(),
    useConfig: (select) => select(bound.hooks.config.getSnapshot()),
    ...Object.fromEntries(Object.entries(bound).filter(([key]) => key !== 'hooks').map(([key, value]) => [key, (key === 'edit')
      ? (field, text) => { edits.push({ field, text }); value(field, text) }
      : value])),
  }
  const vdom = harness.render(Component, props)
  // Shared form chrome carries the localized labels and the save/discard wiring.
  const form = find(vdom, (node) => node.type === SettingsForm)
  assert.deepEqual(Object.keys(form.props.labels).sort(), ['readOnly', 'save', 'saveFailed', 'saving', 'unavailable'])
  assert.equal(form.props.onSave, bound.save)
  assert.equal(form.props.onDiscard, bound.discard)
  // The baseUrl value field and the token secret field carry their copy.
  const valueField = find(vdom, (node) => node.type === SettingsValueField)
  assert.equal(valueField.props.id, 'airboard-config-base-url')
  assert.equal(valueField.props.label, 't:config.baseUrl')
  assert.equal(valueField.props.disabled, false)
  const secretField = find(vdom, (node) => node.type === SettingsSecretField)
  assert.equal(secretField.props.id, 'airboard-config-token')
  assert.equal(secretField.props.stateLabel, bound.hooks.config.getSnapshot().tokenConfigured ? 't:config.tokenSet' : 't:config.tokenUnset')
  // Edits route through the injected staged-form action.
  valueField.props.onEdit('http://other:3010')
  secretField.props.onEdit('abt_secret')
  assert.deepEqual(edits, [
    { field: 'baseUrl', text: 'http://other:3010' },
    { field: 'token', text: 'abt_secret' },
  ])
})

test('the config card renders the summary one-liner when asked', () => {
  const { harness, Component, face } = bootConfigCard()
  const bound = face
  const summary = harness.render(Component, {
    view: 'summary', t: makeT(),
    useConfig: (select) => select(bound.hooks.config.getSnapshot()),
  })
  assert.deepEqual(texts(summary), ['t:config.summary'])
})

test('the body loads projects and resources through the same-origin proxy', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { body: [{ key: 'CORE', name: 'Core' }, { key: 'OPS', name: 'Operations' }] },
    '/airboard/api/projects/CORE/resources': { body: RESOURCES },
  })
  assert.deepEqual(view.calls, ['/airboard/api/projects', '/airboard/api/projects/CORE/resources'])
  // Project selector offers both projects; CORE selected by default.
  const select = find(view.vdom, (node) => node.props['data-airboard-project'] !== undefined)
  assert.equal(select.type, 'select')
  assert.deepEqual(select.children.map((option) => option.props.value), ['CORE', 'OPS'])
  assert.equal(select.props.value, 'CORE')
  // Groups follow the AirBoard kind order, most recently updated first inside.
  const kinds = findAll(view.vdom, (node) => node.props['data-airboard-kind'] !== undefined)
    .map((node) => node.props['data-airboard-kind'])
  assert.deepEqual(kinds, ['ADR', 'PRD', 'ISSUE'])
  const adrRows = findAll(view.vdom, (node) => typeof node.props['data-airboard-row'] === 'string')
    .filter((row) => texts(row).some((text) => text.startsWith('ADR-')))
  assert.deepEqual(adrRows.map((row) => texts(row)[0]), ['ADR-2', 'ADR-1'])
  // Status dots carry the lifecycle state for styling.
  assert.equal(adrRows[0].children[0].props['data-status'], 'active')
  assert.equal(adrRows[1].children[0].props['data-status'], 'done')
  // First resource preselected: its markdown and labels reach the shared renderer.
  const markdown = find(view.vdom, (node) => node.type === MarkdownText)
  assert.equal(markdown.props.text, '# ADR-2\nBecause one file is enough.')
  assert.equal(markdown.props.labels.code.copyLabel, 't:code.copy')
  assert.equal(markdown.props.labels.footnotes, 't:code.footnotes')
})

test('selecting a row shows its markdown; the refresh command refetches', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { body: [{ key: 'CORE', name: 'Core' }] },
    '/airboard/api/projects/CORE/resources': { body: RESOURCES },
  })
  assert.equal(typeof view.commands.refresh, 'function')
  const before = view.calls.length
  await view.interact(() => {
    const issueRow = find(view.vdom, (node) => node.props['data-airboard-row'] === 'ISSUE-9')
    issueRow.props.onClick()
  })
  const markdown = find(view.vdom, (node) => node.type === MarkdownText)
  assert.equal(markdown.props.text, '# ISSUE-9\nCancelled.')
  const meta = find(view.vdom, (node) => node.props['data-airboard-doc-meta'] !== undefined)
  assert.ok(texts(meta).join(' ').includes('t:status.cancelled'))
  await view.interact(() => { view.commands.refresh() })
  assert.equal(view.calls.length, before + 2)
})

test('switching projects fetches the other project and resets selection', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { body: [{ key: 'CORE', name: 'Core' }, { key: 'OPS', name: 'Operations' }] },
    '/airboard/api/projects/CORE/resources': { body: RESOURCES },
    '/airboard/api/projects/OPS/resources': { body: [{ id: 'SPEC-1', kind: 'SPEC', number: 1, project_key: 'OPS', title: 'Ops spec', status: 'draft', content_markdown: 'OPS spec body', rev: 1, updated_at: '2026-10-02 00:00:00' }] },
  })
  await view.interact(() => {
    const select = find(view.vdom, (node) => node.props['data-airboard-project'] !== undefined)
    select.props.onChange({ target: { value: 'OPS' } })
  })
  assert.ok(view.calls.includes('/airboard/api/projects/OPS/resources'))
  const markdown = find(view.vdom, (node) => node.type === MarkdownText)
  assert.equal(markdown.props.text, 'OPS spec body')
})

test('a 401 upstream surfaces the configure hint', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } } },
  })
  const error = find(view.vdom, (node) => node.props['data-airboard-error'] !== undefined)
  assert.ok(texts(error).join(' ').includes('t:error.unauthorized'))
})

test('an unreachable service surfaces the network error', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { throw: new TypeError('fetch failed') },
  })
  const error = find(view.vdom, (node) => node.props['data-airboard-error'] !== undefined)
  assert.ok(texts(error).join(' ').includes('t:error.unreachable'))
})

test('a project with no visible resources shows the empty note', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { body: [{ key: 'EMPTY', name: 'Empty' }] },
    '/airboard/api/projects/EMPTY/resources': { body: [] },
  })
  const note = find(view.vdom, (node) => node.props['data-airboard-note'] !== undefined)
  assert.ok(texts(note).join(' ').includes('t:empty.resources'))
})

test('switching projects aborts the superseded resources fetch', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { body: [{ key: 'CORE', name: 'Core' }, { key: 'OPS', name: 'Operations' }] },
    '/airboard/api/projects/CORE/resources': { body: RESOURCES },
    '/airboard/api/projects/OPS/resources': { body: [] },
  })
  const core = view.signals.find((entry) => entry.url.endsWith('/CORE/resources'))
  assert.equal(core.signal.aborted, false)
  await view.interact(() => {
    const select = find(view.vdom, (node) => node.props['data-airboard-project'] !== undefined)
    select.props.onChange({ target: { value: 'OPS' } })
  })
  // The cleanup of the superseded effect aborted the CORE fetch's controller.
  assert.equal(core.signal.aborted, true)
})

test('no visible projects shows the projects hint', async () => {
  const view = await renderBody({
    '/airboard/api/projects': { body: [] },
  })
  const note = find(view.vdom, (node) => node.props['data-airboard-note'] !== undefined)
  assert.ok(texts(note).join(' ').includes('t:empty.projects'))
})
