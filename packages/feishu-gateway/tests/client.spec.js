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
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'])

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

test('the config card renders three staged fields with zh and en copy', () => {
  let primitiveRequire
  const model = new FakeFormModel(
    { getSnapshot: () => ({ status: 'ready', writable: true, value: { appId: 'cli_1', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn' } }) },
    [{ field: 'appId' }, { field: 'appSecretEnv' }, { field: 'domain' }],
  )
  const rendered = []
  const plugin = loaded[0].factory(name => {
    if (name === 'react') return { createElement: (type, props, ...children) => { const el = { type, props: props ?? {}, children }; rendered.push(el); return el } }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      primitiveRequire = true
      return { SettingsForm, SettingsValueField, SettingsFormModel: FakeFormModel, settingsTextField: (field) => ({ field }) }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  assert.ok(primitiveRequire)

  // Capture the card component through the slot registration.
  let card = null
  const ctx = {
    locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}` },
    configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true }) }) },
    slots: {
      inject: (_slot, register) => { card = register(); return () => {} },
      register: (declaration, component) => ({ declaration, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  }
  plugin.apply(ctx)
  assert.equal(typeof card.component, 'function', 'slot register returns the card component')

  const hooks = { useConfig: (sel) => sel({
    writable: true, available: true, dirty: false, invalid: false, saving: false, failed: false,
    appId: { text: 'cli_1', overridden: false, invalid: null },
    appSecretEnv: { text: 'FEISHU_APP_SECRET', overridden: false, invalid: null },
    domain: { text: 'https://open.feishu.cn', overridden: false, invalid: null },
  }) }
  const actions = model.actions()
  const element = card.component({ view: 'page', t: (key) => key, ...hooks, ...actions })
  assert.equal(element.type, SettingsForm)
  // The staged field components render into SettingsValueField elements.
  const fields = element.children.flatMap(child => [child.type(child.props)])
  assert.equal(fields.length, 3)
  assert.deepEqual(fields.map(f => f.props.id), [
    'feishu-gateway-config-app-id',
    'feishu-gateway-config-secret-env',
    'feishu-gateway-config-domain',
  ])
  // Summary view renders localized copy, not the form.
  assert.equal(typeof card.component({ view: 'summary', t: (key) => key, ...hooks }), 'string')
})
