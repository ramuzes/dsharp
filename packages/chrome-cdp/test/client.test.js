import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Browser-half contract tests for the Plugins-page config card, after the
 * task brief's minimal __ModuleLoader__ harness (a Function-evaluated module
 * body — no jsdom). The brief's note allows extending the fake module table
 * "as needed to satisfy real imports"; the table below mirrors the REAL
 * export set strictly: '@deepseek-ai/dsh-client-ui-primitives' offers
 * SettingsForm, SettingsValueField, SettingsSecretField, SettingsFormModel,
 * settingsTextField, settingsNumberField — and NO select or textarea
 * primitive (verified in the dsh checkout,
 * packages/client/ui-primitives/src/index.ts), so the fake offers no
 * SettingsSelectField either: a client that reached for one would fail here
 * exactly as it would in the browser module table.
 */

/** The module body under test, read lazily so the missing-file failure lands inside test 1. */
let srcCache
const clientSource = () => {
  srcCache ??= readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  return srcCache
}

/** Marker components standing in for the shared staged-form chrome. */
function SettingsForm(props) { return { type: 'SettingsForm', props } }
function SettingsValueField(props) { return { type: 'SettingsValueField', props } }

/**
 * Faithful twins of the real spec factories, transcribed from the dsh
 * checkout (packages/client/ui-primitives/src/settings-form/form-model.ts:156-186)
 * so spec-level assertions exercise real conversion semantics.
 */
const settingsTextFieldFake = (field) => ({
  field,
  format: (value) => typeof value === 'string' ? value : '',
  parse: (text) => {
    const trimmed = text.trim()
    return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
  },
})
const settingsNumberFieldFake = (field) => ({
  field,
  format: (value) => typeof value === 'number' ? String(value) : '',
  parse: (text) => {
    const trimmed = text.trim()
    if (trimmed === '') return { kind: 'clear' }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
  },
})

/**
 * A fake SettingsFormModel over a stub scope, mirroring the real surface the
 * card consumes (form-model.ts: constructor/subscribe, bind, shell, field,
 * actions, dispose). field() runs the REAL spec parse/format the plugin
 * installed, so staging semantics (overridden/invalid) are the real ones.
 */
class FakeFormModel {
  static instances = []
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specList = specs
    this.specs = new Set(specs.map((spec) => spec.field))
    this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.disposed = false
    this.listeners = new Set()
  }
  bind(project) {
    this.project = project
    FakeFormModel.instances.push(this)
    return {
      getSnapshot: () => project(),
      subscribe: (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) },
    }
  }
  emit() { for (const listener of this.listeners) listener() }
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
  specOf(field) { return this.specList.find((spec) => spec.field === field) }
  field(name) {
    if (this.secretSpecs.has(name)) return { text: this.staged.get(name)?.text ?? '', overridden: false, invalid: false }
    if (!this.specs.has(name)) throw new Error(`unregistered field: ${name}`)
    const staged = this.staged.get(name)
    if (staged === undefined) {
      const snapshot = this.scope.getSnapshot()
      return {
        text: this.specOf(name).format(snapshot.value?.[name]),
        overridden: Object.hasOwn(snapshot.user ?? {}, name),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' } : this.specOf(name).parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }
  actions() {
    return {
      edit: (name, text) => { this.staged.set(name, { text, clear: false }); this.emit() },
      resetField: (name) => {
        this.staged.set(name, { text: this.specOf(name).format(this.scope.getSnapshot().base?.[name]), clear: true })
        this.emit()
      },
      save: async () => { this.staged.clear(); this.emit() },
      discard: () => { this.staged.clear(); this.emit() },
    }
  }
  dispose() { this.disposed = true; this.listeners.clear() }
}

/**
 * Fake React mirroring the real surface the card consumes: createElement
 * (plain tree nodes), Fragment, and the three hooks the status section uses.
 * useState records setter calls (state itself never re-renders — renders
 * here are synchronous one-shots) so tests can assert what the contained
 * fetch delivered; useCallback passes through; effects run immediately.
 */
const makeFakeReact = () => {
  const stateSets = []
  const react = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, (value) => { stateSets.push(value) }],
    useCallback: (fn) => fn,
    useEffect: (fn) => { fn(); return () => {} },
  }
  return { react, stateSets }
}

/** The fake module table: exactly the two ids a real browser loader would hand this module. */
const primitivesTable = () => ({
  SettingsForm,
  SettingsValueField,
  SettingsFormModel: FakeFormModel,
  settingsTextField: settingsTextFieldFake,
  settingsNumberField: settingsNumberFieldFake,
})

/** A strict fake ConfigForm for the chrome-cdp row. */
const fakeConfigForm = () => ({
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    revision: 7,
    value: {
      mode: 'url', endpoint: 'http://127.0.0.1:9223', channel: 'stable',
      approvalPolicy: 'sensitive', readOnlyTools: ['take_snapshot'], toolCallTimeoutMs: 45000,
    },
    base: {},
    user: {},
  }),
  subscribe: () => () => {},
  mutate: async () => true,
})

/** Boot client.js the way a browser loader would: fresh window, factory executed. */
function boot(react) {
  const loaded = {}
  const modules = { react, '@deepseek-ai/dsh-client-ui-primitives': primitivesTable() }
  const require = (id) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`)
    return modules[id]
  }
  const window = { __ModuleLoader__: { load(def) { loaded.id = def.id; loaded.plugin = def.factory(require) } } }
  new Function('window', 'require', clientSource())(window, require) // executes the module body
  return loaded
}

/** Apply the booted plugin against a strict fake ctx and capture every registration. */
function applyWith(plugin, options = {}) {
  const captured = { locale: [], slots: [], mounts: [], disposers: [], row: undefined }
  const ctx = {
    locale: { register: (ns, dicts) => { captured.locale.push({ ns, dicts }); return () => {} } },
    configForms: { get: (row) => { captured.row = row; return options.configForm ?? fakeConfigForm() } },
    remote: { $mount: (def) => { captured.mounts.push(def); return Promise.resolve(async () => {}) } },
    slots: {
      inject: (slot, register) => { captured.slots.push({ slot, entry: register() }); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { const dispose = fn(); captured.disposers.push(dispose); return () => {} },
    get: (name) => name === 'remote.chromeCdp' ? options.remoteChromeCdp : undefined,
  }
  plugin.apply(ctx)
  return captured
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('client.js loads through __ModuleLoader__ and registers the config card slot', () => {
  const loaded = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(def) { loaded.id = def.id; loaded.plugin = def.factory(require) },
    },
  }
  const modules = { react: makeFakeReact().react, '@deepseek-ai/dsh-client-ui-primitives': primitivesTable() }
  const require = (id) => modules[id]
  const fn = new Function('window', 'require', clientSource()) // executes the module body
  fn(globalThis.window, require)
  assert.equal(loaded.id, 'dsh-chrome-cdp')
  assert.deepEqual(loaded.plugin.inject, ['slots', 'locale', 'configForms', 'remote'])
  assert.equal(typeof loaded.plugin.apply, 'function')
})

test('apply registers the dictionary, the bundle config card slot, and the chromeCdp remote namespace', async () => {
  const loaded = boot(makeFakeReact().react)
  const captured = applyWith(loaded.plugin)

  // The row whose shared ConfigForm backs the card.
  assert.equal(captured.row, 'chrome-cdp')

  // Slot registration — checked verbatim against the brief.
  assert.equal(captured.slots.length, 1)
  const { slot, entry } = captured.slots[0]
  assert.equal(slot, 'plugins.bundle.config')
  assert.equal(entry.declaration.name, 'plugins.bundle.config')
  assert.equal(entry.declaration.key, 'dsh-chrome-cdp')
  assert.equal(entry.declaration.locale, 'chromeCdp')
  assert.equal(typeof entry.declaration.inject, 'function')
  assert.equal(typeof entry.component, 'function')
  const face = entry.declaration.inject()
  assert.equal(typeof face.hooks.config.getSnapshot, 'function')
  assert.equal(typeof face.hooks.config.subscribe, 'function')

  // zh/en dictionaries carry every field label + hint and the status copy.
  assert.equal(captured.locale.length, 1)
  assert.equal(captured.locale[0].ns, 'chromeCdp')
  for (const key of ['zh', 'en']) {
    const dict = captured.locale[0].dicts[key]
    assert.ok(dict, key)
    assert.equal(typeof dict['config.summary'], 'string')
    for (const field of ['mode', 'endpoint', 'channel', 'approvalPolicy', 'readOnlyTools', 'toolCallTimeoutMs']) {
      assert.equal(typeof dict[`config.${field}`], 'string', `${key} config.${field}`)
      assert.equal(typeof dict[`config.${field}Hint`], 'string', `${key} config.${field}Hint`)
    }
    assert.equal(typeof dict['status.refresh'], 'string')
    assert.equal(typeof dict['status.unavailable'], 'string')
  }

  // The chromeCdp remote namespace mount (host half: lib/status.js ChromeCdpStatus).
  assert.equal(captured.mounts.length, 1)
  assert.equal(captured.mounts[0].package, 'dsh-chrome-cdp')
  assert.deepEqual(captured.mounts[0].descriptors, [{
    id: 'dsh-chrome-cdp#chromeCdp/status', service: 'chromeCdp', namespace: 'chromeCdp',
    method: 'status', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
  }])

  // Every effect disposer runs clean, and disposing tears the model down.
  for (const dispose of captured.disposers) assert.doesNotThrow(() => dispose?.())
  await flush()
  assert.equal(FakeFormModel.instances.at(-1).disposed, true)
})

test('the config card renders six staged chrome-cdp-config fields and no secret control', () => {
  const loaded = boot(makeFakeReact().react)
  const captured = applyWith(loaded.plugin)
  const card = captured.slots[0].entry
  const face = card.declaration.inject()
  const useConfig = (selector) => selector(face.hooks.config.getSnapshot())
  const actions = { edit: face.edit, resetField: face.resetField, save: face.save, discard: face.discard }
  const t = (key) => key

  assert.equal(typeof card.component({ view: 'summary', t, useConfig }), 'string')
  const element = card.component({ view: 'page', t, useConfig, ...actions })
  assert.equal(element.type, 'Fragment', 'page view renders status section + form in a fragment')
  assert.equal(typeof element.children[0].type, 'function', 'status section rendered first')
  const form = element.children[1]
  assert.equal(form.type, SettingsForm)
  const fields = form.children.filter((child) => typeof child.type === 'function')
  assert.equal(fields.length, 6)
  const rendered = fields.map((child) => child.type(child.props))
  assert.ok(rendered.every((f) => f.type === SettingsValueField), 'no primitive outside the feishu precedent set')
  assert.deepEqual(rendered.map((f) => f.props.id), [
    'chrome-cdp-config-mode',
    'chrome-cdp-config-endpoint',
    'chrome-cdp-config-channel',
    'chrome-cdp-config-approval-policy',
    'chrome-cdp-config-read-only-tools',
    'chrome-cdp-config-tool-call-timeout-ms',
  ])

  // Staging routes through the face's actions and invalid drafts mark the
  // field. React's useSyncExternalStore subscribes before reading, so the
  // test subscribes first too — cache invalidation rides the subscription.
  const off = face.hooks.config.subscribe(() => {})
  rendered[0].props.onEdit('bogus')
  assert.equal(face.hooks.config.getSnapshot().mode.invalid, true, 'illegal mode blocks the save')
  rendered[0].props.onEdit('ws')
  const next = face.hooks.config.getSnapshot()
  assert.equal(next.mode.text, 'ws')
  assert.equal(next.mode.invalid, false)
  off()
})

test('the status section fetches remote.chromeCdp.status() on mount and degrades contained', async () => {
  const status = {
    mode: 'url', endpoint: 'http://127.0.0.1:9223', channel: 'stable', approvalPolicy: 'sensitive',
    readOnlyToolCount: 27, serverEntry: '/node/chrome-devtools-mcp.js', exclusive: true,
  }

  // Present namespace: the mount-time fetch delivers the host status.
  {
    const { react, stateSets } = makeFakeReact()
    const captured = applyWith(boot(react).plugin, { remoteChromeCdp: { status: async () => status } })
    const card = captured.slots[0].entry
    const face = card.declaration.inject()
    const element = card.component({ view: 'page', t: (key) => key, useConfig: (selector) => selector(face.hooks.config.getSnapshot()) })
    const section = element.children[0].type(element.children[0].props)
    const header = section.children[0]
    const refresh = header.children.find((child) => child.type === 'button')
    assert.ok(refresh, 'refresh button rendered')
    assert.equal(typeof refresh.props.onClick, 'function')
    assert.equal(refresh.children[0], 'status.refresh')
    await flush()
    assert.deepEqual(stateSets.at(-1), status, 'mount fetch resolves into the section state')
  }

  // Missing namespace: contained — setState(null), never a throw.
  {
    const { react, stateSets } = makeFakeReact()
    const captured = applyWith(boot(react).plugin)
    const card = captured.slots[0].entry
    const face = card.declaration.inject()
    const element = card.component({ view: 'page', t: (key) => key, useConfig: (selector) => selector(face.hooks.config.getSnapshot()) })
    assert.doesNotThrow(() => element.children[0].type(element.children[0].props))
    assert.ok(stateSets.includes(null), 'missing namespace renders unavailable')
  }

  // Throwing status(): the rejection is caught, still unavailable.
  {
    const { react, stateSets } = makeFakeReact()
    const captured = applyWith(boot(react).plugin, { remoteChromeCdp: { status: () => { throw new Error('boom') } } })
    const card = captured.slots[0].entry
    const face = card.declaration.inject()
    const element = card.component({ view: 'page', t: (key) => key, useConfig: (selector) => selector(face.hooks.config.getSnapshot()) })
    element.children[0].type(element.children[0].props)
    await flush()
    assert.ok(stateSets.includes(null), 'a throwing status() degrades to unavailable, not an unhandled rejection')
  }
})

test('field specs mirror the host Config schema', () => {
  const loaded = boot(makeFakeReact().react)
  applyWith(loaded.plugin)
  const model = FakeFormModel.instances.at(-1)
  const specOf = (field) => {
    const spec = model.specList.find((s) => s.field === field)
    assert.ok(spec, field)
    return spec
  }

  // mode: Schema.union(auto/url/ws).required() — illegal or empty blocks the save.
  const mode = specOf('mode')
  assert.equal(mode.format('ws'), 'ws')
  assert.deepEqual(mode.parse(' auto '), { kind: 'set', value: 'auto' })
  assert.equal(mode.parse('bogus'), undefined, 'illegal mode blocks the save')
  assert.equal(mode.parse(''), undefined, 'required mode never stages a clear')

  // endpoint: plain string, clearable (auto mode carries none).
  const endpoint = specOf('endpoint')
  assert.deepEqual(endpoint.parse(' http://127.0.0.1:9223 '), { kind: 'set', value: 'http://127.0.0.1:9223' })
  assert.deepEqual(endpoint.parse(''), { kind: 'clear' })

  // channel: pattern ^[a-z][a-z0-9-]*$ with default 'stable'.
  const channel = specOf('channel')
  assert.deepEqual(channel.parse('beta'), { kind: 'set', value: 'beta' })
  assert.equal(channel.parse('Beta'), undefined, 'pattern violation blocks the save')
  assert.deepEqual(channel.parse(''), { kind: 'clear' }, 'blank channel re-inherits stable')

  // approvalPolicy: union sensitive/all/none with default 'sensitive'.
  const policy = specOf('approvalPolicy')
  assert.deepEqual(policy.parse('all'), { kind: 'set', value: 'all' })
  assert.equal(policy.parse('everything'), undefined)
  assert.deepEqual(policy.parse(''), { kind: 'clear' }, 'blank policy re-inherits sensitive')

  // readOnlyTools: string[] <-> newline-joined lines; blank re-inherits the default list.
  const tools = specOf('readOnlyTools')
  assert.equal(tools.format(['take_snapshot', 'take_screenshot']), 'take_snapshot\ntake_screenshot')
  assert.equal(tools.format(undefined), '')
  assert.deepEqual(tools.parse('take_snapshot, take_screenshot\nwait_for'), {
    kind: 'set', value: ['take_snapshot', 'take_screenshot', 'wait_for'],
  })
  assert.deepEqual(tools.parse('  '), { kind: 'clear' }, 'blank list re-inherits the default set')

  // toolCallTimeoutMs: number with the schema's min(1).
  const timeout = specOf('toolCallTimeoutMs')
  assert.equal(timeout.format(45000), '45000')
  assert.deepEqual(timeout.parse('45000'), { kind: 'set', value: 45000 })
  assert.deepEqual(timeout.parse(''), { kind: 'clear' })
  assert.equal(timeout.parse('0'), undefined, 'schema min(1) mirrored: 0 blocks the save')
  assert.equal(timeout.parse('soon'), undefined)
})

test('the config snapshot identity is stable between notifications (React #185 regression)', () => {
  const loaded = boot(makeFakeReact().react)
  const captured = applyWith(loaded.plugin)
  const face = captured.slots[0].entry.declaration.inject()

  // Between notifications, getSnapshot must return the SAME object: React's
  // useSyncExternalStore loops (Minified React error #185) when every call
  // yields a fresh identity. React subscribes before reading; so does this.
  let notified = 0
  const off = face.hooks.config.subscribe(() => { notified += 1 })
  const first = face.hooks.config.getSnapshot()
  assert.strictEqual(face.hooks.config.getSnapshot(), first, 'repeated getSnapshot keeps identity')
  assert.strictEqual(face.hooks.config.getSnapshot(), first, 'repeated getSnapshot keeps identity (again)')

  // A form-model notification invalidates the cache: next read recomputes.
  FakeFormModel.instances.at(-1).emit()
  assert.notStrictEqual(face.hooks.config.getSnapshot(), first, 'notification recomputes the snapshot')
  assert.ok(notified >= 1)
  assert.doesNotThrow(() => off())
})
