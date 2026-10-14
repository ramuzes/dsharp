/**
 * Browser-half contract tests: boot client.js against a stub __ModuleLoader__,
 * feed the factory a stub require (fake React + primitives), and exercise the
 * returned cordis plugin's registration surface — the bundle config card on
 * the Plugins page.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Capture the load() registration the script performs on import. */
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
await import('../client.js')

/** Marker components standing in for the shared staged-form chrome. */
function SettingsForm(props) { return { type: 'settings-form', props } }
function SettingsValueField(props) { return { type: 'settings-value-field', props } }
function SettingsSecretField(props) { return { type: 'settings-secret-field', props } }

/**
 * Fake React mirroring the real surface the card consumes: createElement
 * (plain tree nodes), Fragment, and the three hooks the diagnostics section
 * uses (useState/useCallback/useEffect). Hook semantics are minimal — state
 * never updates (renders here are synchronous one-shots) and effects run
 * immediately — which is exactly what the assertions rely on.
 */
const fakeReact = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: () => [undefined, () => {}],
  useCallback: fn => fn,
  useEffect: fn => { fn(); return () => {} },
}

/** Fake remote service: credentials face (per test) plus $mount for namespaces. */
const fakeRemote = (credentials) => ({
  ...(credentials === undefined ? {} : { credentials }),
  $mount: async () => async () => {},
})

/** A fake SettingsFormModel over a stub scope. */
class FakeFormModel {
  static instances = []
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = new Set(specs.map(spec => spec.field))
    this.secretSpecs = new Map(secrets.map(spec => [spec.field, spec]))
    this.staged = new Map()
    this.disposed = false
  }
  bind(project) {
    this.project = project
    const listeners = new Set()
    this.emit = () => { for (const listener of listeners) listener() }
    FakeFormModel.instances.push(this)
    return { getSnapshot: () => project(), subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
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
    if (this.secretSpecs.has(name)) {
      const staged = this.staged.get(name)
      return { text: staged === undefined ? '' : staged, overridden: false, invalid: null }
    }
    const snapshot = this.scope.getSnapshot()
    if (!this.specs.has(name)) throw new Error(`unregistered field: ${name}`)
    return { text: snapshot.value?.[name] ?? '', overridden: false, invalid: null }
  }
  actions() {
    return {
      edit: (n, v) => this.staged.set(n, v),
      resetField: () => {},
      save: async () => {
        for (const [name, spec] of this.secretSpecs) {
          const text = this.staged.get(name)
          if (text !== undefined && text !== '') await spec.write(text)
        }
        this.staged.clear()
      },
      discard: () => { this.staged.clear() },
    }
  }
  dispose() { this.disposed = true }
}

test('registers one plugin under the package id in factory format', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-feishu-gateway')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('the plugin registers a bundle config card into plugins.bundle.config', () => {
  const plugin = loaded[0].factory(name => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { SettingsForm, SettingsValueField, SettingsFormModel: FakeFormModel, settingsTextField: (field) => ({ field }) }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])

  const registrations = []
  const ctx = {
    locale: { register: () => () => {} },
    configForms: { get: (row) => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: { appId: 'cli_1', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn' } }) }) },
    remote: fakeRemote(),
    slots: {
      inject: (slot, register) => { registrations.push(slot); register(); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  }
  plugin.apply(ctx)
  assert.deepEqual(registrations, ['plugins.bundle.config'])
})

test('the config snapshot identity is stable between notifications (React #185 regression)', async () => {
  const model = new FakeFormModel(
    { getSnapshot: () => ({ status: 'ready', writable: true, value: { appId: 'cli_1', domain: 'https://open.feishu.cn' } }) },
    [{ field: 'appId' }, { field: 'domain' }],
  )
  let configured = false
  const plugin = loaded[0].factory(name => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        SettingsForm, SettingsValueField, SettingsSecretField,
        SettingsFormModel: FakeFormModel, settingsTextField: (field) => ({ field }),
      }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  let card = null
  const ctx = {
    locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
    configForms: { get: () => model.scope },
    remote: fakeRemote({
      describe: async (refs) => ({ ok: true, value: { [refs[0]]: { configured } } }),
      set: async () => {},
    }),
    slots: {
      inject: (_slot, register) => { card = register(); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  }
  plugin.apply(ctx)
  const face = card.declaration.inject()

  // Between notifications, getSnapshot must return the SAME object: React's
  // useSyncExternalStore loops (Minified React error #185) when every call
  // yields a fresh identity. React subscribes before reading; so does this.
  let notified = 0
  const off = face.hooks.config.subscribe(() => { notified += 1 })
  const first = face.hooks.config.getSnapshot()
  assert.strictEqual(face.hooks.config.getSnapshot(), first, 'repeated getSnapshot keeps identity')
  assert.strictEqual(face.hooks.config.getSnapshot(), first, 'repeated getSnapshot keeps identity (again)')

  // A form-model notification invalidates the cache: next read recomputes
  // (new identity) with current field projections.
  FakeFormModel.instances.at(-1).emit()
  assert.notStrictEqual(face.hooks.config.getSnapshot(), first, 'notification recomputes the snapshot')

  // A credential write refreshes presence and notifies subscribers; the
  // snapshot then reports the new presence.
  const before = notified
  configured = true
  face.edit('appSecret', 'sk_new')
  await face.save()
  assert.ok(notified > before, 'subscribers heard the presence refresh')
  assert.equal(face.hooks.config.getSnapshot().secretConfigured, true)
  off()
})

test('the config card renders two staged fields plus a credentials-backed secret control', async () => {
  const model = new FakeFormModel(
    { getSnapshot: () => ({ status: 'ready', writable: true, value: { appId: 'cli_1', domain: 'https://open.feishu.cn' } }) },
    [{ field: 'appId' }, { field: 'domain' }],
  )
  const credentialCalls = []
  let configured = false
  const plugin = loaded[0].factory(name => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        SettingsForm, SettingsValueField, SettingsSecretField,
        SettingsFormModel: FakeFormModel, settingsTextField: (field) => ({ field }),
      }
    }
    throw new Error(`unexpected require: ${name}`)
  })

  // Capture the card component through the slot registration; the face's
  // storeSecret writes through remote.credentials.
  let card = null
  const ctx = {
    locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
    configForms: { get: () => model.scope },
    remote: fakeRemote({
      describe: async (refs) => { credentialCalls.push(['describe', ...refs]); return { ok: true, value: { [refs[0]]: { configured } } } },
      set: async (ref, value) => { credentialCalls.push(['set', ref, value]); configured = true; return { ok: true } },
    }),
    slots: {
      inject: (_slot, register) => { card = register(); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  }
  plugin.apply(ctx)
  assert.equal(typeof card.component, 'function', 'slot register returns the card component')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])

  const hooks = { useConfig: (sel) => sel({
    writable: true, available: true, dirty: false, invalid: false, saving: false, failed: false,
    appId: { text: 'cli_1', overridden: false, invalid: null },
    domain: { text: 'https://open.feishu.cn', overridden: false, invalid: null },
    appSecret: { text: '', overridden: false, invalid: null },
    secretConfigured: false,
  }) }
  const face = card.declaration.inject()
  // Stage through the face's actions: the plugin builds its own model over
  // the shared scope, so the test's local model is not the staging surface.
  const actions = { edit: face.edit, resetField: face.resetField, save: face.save, discard: face.discard }
  assert.equal(face.storeSecret, undefined, 'the face exposes only staged-form actions')
  const element = card.component({ view: 'page', t: (key) => key, ...hooks, ...actions })
  assert.equal(element.type, 'Fragment', 'page view renders diagnostics + form in a fragment')
  assert.equal(typeof element.children[0].type, 'function', 'diagnostics section rendered first')
  const form = element.children[1]
  assert.equal(form.type, SettingsForm)
  const staged = form.children.filter(child => typeof child.type === 'function' && child.type !== SettingsSecretField)
  assert.equal(staged.length, 2)
  const fields = staged.flatMap(child => [child.type(child.props)])
  assert.deepEqual(fields.map(f => f.props.id), [
    'feishu-gateway-config-app-id',
    'feishu-gateway-config-domain',
  ])
  const secret = form.children.find(child => child.type === SettingsSecretField)
  assert.ok(secret, 'secret control rendered')
  assert.equal(secret.props.id, 'feishu-gateway-config-app-secret')
  assert.equal(secret.props.configured, false, 'presence projected from the presence store')
  // The write path: typing only stages; the save writes through
  // remote.credentials.set (then a presence refresh), never the form value.
  secret.props.onEdit('sk_secret')
  assert.ok(!credentialCalls.some(c => c[0] === 'set'), 'typing alone writes nothing')
  await face.save()
  assert.ok(credentialCalls.some(c => c[0] === 'set' && c[1] === 'FEISHU_APP_SECRET' && c[2] === 'sk_secret'),
    'secret written through remote.credentials.set on save')
  assert.equal(typeof card.component({ view: 'summary', t: (key) => key, ...hooks }), 'string')
})
