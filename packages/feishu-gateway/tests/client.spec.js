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

/** A fake SettingsFormModel over a stub scope. */
class FakeFormModel {
  constructor(scope, specs) {
    this.scope = scope
    this.specs = new Set(specs.map(spec => spec.field))
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
    if (!this.specs.has(name)) throw new Error(`unregistered field: ${name}`)
    return { text: snapshot.value?.[name] ?? '', overridden: false, invalid: null }
  }
  actions() { return { edit: (n, v) => this.staged.set(n, v), resetField: () => {}, save: async () => {}, discard: () => {} } }
  dispose() { this.disposed = true }
}

test('registers one plugin under the package id in factory format', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-feishu-gateway')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('the plugin registers a bundle config card into plugins.bundle.config', () => {
  const plugin = loaded[0].factory(name => {
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { SettingsForm, SettingsValueField, SettingsFormModel: FakeFormModel, settingsTextField: (field) => ({ field }) }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms', 'remote.credentials'])

  const registrations = []
  const ctx = {
    locale: { register: () => () => {} },
    configForms: { get: (row) => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: { appId: 'cli_1', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn' } }) }) },
    slots: {
      inject: (slot, register) => { registrations.push(slot); register(); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  }
  plugin.apply(ctx)
  assert.deepEqual(registrations, ['plugins.bundle.config'])
})

test('the config card renders two staged fields plus a credentials-backed secret control', async () => {
  const model = new FakeFormModel(
    { getSnapshot: () => ({ status: 'ready', writable: true, value: { appId: 'cli_1', domain: 'https://open.feishu.cn' } }) },
    [{ field: 'appId' }, { field: 'domain' }],
  )
  const credentialCalls = []
  let configured = false
  const plugin = loaded[0].factory(name => {
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
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
    remote: { credentials: {
      describe: async (refs) => { credentialCalls.push(['describe', ...refs]); return { ok: true, value: { [refs[0]]: { configured } } } },
      set: async (ref, value) => { credentialCalls.push(['set', ref, value]); configured = true; return { ok: true } },
    } },
    slots: {
      inject: (_slot, register) => { card = register(); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  }
  plugin.apply(ctx)
  assert.equal(typeof card.component, 'function', 'slot register returns the card component')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms', 'remote.credentials'])

  const hooks = { useConfig: (sel) => sel({
    writable: true, available: true, dirty: false, invalid: false, saving: false, failed: false,
    appId: { text: 'cli_1', overridden: false, invalid: null },
    domain: { text: 'https://open.feishu.cn', overridden: false, invalid: null },
    secretConfigured: false,
  }) }
  const actions = model.actions()
  const storeSecret = card.declaration.inject().storeSecret
  assert.equal(typeof storeSecret, 'function', 'face exposes storeSecret')
  const element = card.component({ view: 'page', t: (key) => key, ...hooks, ...actions, storeSecret })
  assert.equal(element.type, SettingsForm)
  const staged = element.children.filter(child => typeof child.type === 'function' && child.type !== SettingsSecretField)
  assert.equal(staged.length, 2)
  const fields = staged.flatMap(child => [child.type(child.props)])
  assert.deepEqual(fields.map(f => f.props.id), [
    'feishu-gateway-config-app-id',
    'feishu-gateway-config-domain',
  ])
  const secret = element.children.find(child => child.type === SettingsSecretField)
  assert.ok(secret, 'secret control rendered')
  assert.equal(secret.props.id, 'feishu-gateway-config-app-secret')
  assert.equal(secret.props.configured, false, 'presence projected from the presence store')
  // The write path goes through remote.credentials (then a presence refresh), never the form model.
  await secret.props.onEdit('sk_secret')
  assert.ok(credentialCalls.some(c => c[0] === 'set' && c[1] === 'FEISHU_APP_SECRET' && c[2] === 'sk_secret'),
    'secret written through remote.credentials.set')
  assert.equal(typeof card.component({ view: 'summary', t: (key) => key, ...hooks }), 'string')
})
