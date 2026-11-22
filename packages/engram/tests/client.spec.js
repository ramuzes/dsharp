/**
 * Browser-half contract tests (gitlab/feishu pattern): boot client.js
 * against a stub __ModuleLoader__, feed the factory a stub require (fake
 * React + fake staged-form primitives with a FakeFormModel mirroring the
 * real secret-spec semantics), and exercise the returned cordis plugin:
 * inject list, dictionary parity, slot registration, the credentials-backed
 * token control, and build-failure containment.
 *
 * The inject assertion pins the 0.1.2 incident: the card accessed
 * ctx.remote.credentials without declaring 'remote.credentials', the client
 * inject system threw, containment registered NOTHING, and the whole config
 * card silently disappeared from the Plugins page.
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

/** Fake React mirroring the surface the card consumes. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
}

/**
 * Fake credentials Remote mirroring the REAL wire shape: describe answers
 * { ok, value } with value keyed by ref (CredentialInfo.configured), set
 * stores and records. The previous spec faked a bare object here — more
 * forgiving than the real Remote, which hid two production defects.
 */
function fakeCredentials(store = {}) {
  const api = {
    store,
    setCalls: [],
    describeCalls: [],
    set: async (ref, value) => { api.setCalls.push([ref, value]); api.store[ref] = value },
    describe: async (refs) => {
      api.describeCalls.push([...refs])
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: ref in api.store, writable: true }])) }
    },
  }
  return api
}

/** A fake SettingsFormModel over a stub scope (feishu client.spec pattern). */
class FakeFormModel {
  static instances = []
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = new Set(specs.map((spec) => spec.field))
    this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]))
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
    return { text: String(snapshot.value?.[name] ?? ''), overridden: false, invalid: null }
  }
  actions() {
    return {
      edit: (n, v) => this.staged.set(n, v),
      resetField: () => {},
      save: async () => {
        for (const [name, spec] of this.secretSpecs) {
          const text = this.staged.get(name)
          if (text !== undefined && text.trim() !== '') await spec.write(text.trim())
        }
        this.staged.clear()
      },
      discard: () => { this.staged.clear() },
    }
  }
  dispose() { this.disposed = true }
}

/** Stub SettingsFormScope over the engram row's default config. */
function makeScope(value = {}) {
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: {
      daemonMode: 'auto-spawn',
      port: '',
      httpTokenRef: '',
      autosync: false,
      projectMode: 'auto',
      fixedProject: '',
      projectMap: {},
      contextInjection: 'off',
      contextMaxBytes: 2048,
      ...value,
    },
    base: {},
    user: {},
  }
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
}

/** Boot the browser plugin against fresh fakes; returns everything a test needs. */
function bootPlugin({ scope, credentials } = {}) {
  const form = scope ?? makeScope()
  const secretApi = credentials ?? fakeCredentials()
  const recorded = { namespaces: [], injects: [], registrations: [] }
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    locale: {
      register: (ns, dicts) => {
        recorded.namespaces.push({ ns, dicts })
        return () => {}
      },
    },
    configForms: { get: () => form },
    remote: { credentials: secretApi },
    slots: {
      inject: (name, begin) => { recorded.injects.push(name); return begin() },
      register: (declaration, component) => { recorded.registrations.push({ declaration, component }); return () => {} },
    },
  }
  const plugin = loaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        SettingsForm, SettingsValueField, SettingsSecretField,
        SettingsFormModel: FakeFormModel,
        settingsTextField: (field) => ({ field }),
        settingsNumberField: (field) => ({ field }),
      }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  return { ctx, recorded, plugin, form, secretApi }
}

/** Flat key list of a locale dictionary, for zh/en parity. */
const keysOf = (dict) => Object.keys(dict).sort()

test('factory registers under the package id; inject list includes remote.credentials (0.1.2 incident pin)', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-engram')
  const plugin = loaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { SettingsForm, SettingsValueField, SettingsSecretField, SettingsFormModel: FakeFormModel, settingsTextField: (f) => ({ field: f }), settingsNumberField: (f) => ({ field: f }) }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  // THE regression: without 'remote.credentials' here, ctx.remote.credentials
  // throws in the real client inject system and the card never registers.
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the dictionary (zh/en parity) and one config slot entry keyed dsh-engram', () => {
  const { ctx, recorded, plugin } = bootPlugin()
  plugin.apply(ctx)
  assert.equal(recorded.namespaces.length, 1)
  const { ns, dicts } = recorded.namespaces[0]
  assert.equal(ns, 'engram')
  assert.deepEqual(keysOf(dicts.zh), keysOf(dicts.en))
  assert.deepEqual(recorded.injects, ['plugins.bundle.config'])
  assert.equal(recorded.registrations.length, 1)
  const { declaration, component } = recorded.registrations[0]
  assert.equal(declaration.key, 'dsh-engram')
  assert.equal(declaration.locale, 'engram')
  assert.equal(typeof declaration.inject, 'function')
  assert.equal(typeof component, 'function')
})

test('the token secret control writes through the credentials Remote under the live ref', async () => {
  const { ctx, recorded, plugin, secretApi } = bootPlugin()
  plugin.apply(ctx)
  const face = recorded.registrations[0].declaration.inject()
  // Subscribe like the real page: the face memoizes its snapshot per listener.
  const unsubscribe = face.hooks.config.subscribe(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  face.edit('httpToken', 'tok-live-1')
  await face.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(secretApi.setCalls, [['ENGRAM_HTTP_TOKEN', 'tok-live-1']])
  assert.equal(face.hooks.config.getSnapshot().httpToken.text, '', 'staged draft clears after save')
  unsubscribe()
})

test('an overridden httpTokenRef changes the credential ref the control writes', async () => {
  const { ctx, recorded, plugin, secretApi } = bootPlugin({ scope: makeScope({ httpTokenRef: 'MY_ENGRAM_TOKEN' }) })
  plugin.apply(ctx)
  const face = recorded.registrations[0].declaration.inject()
  const unsubscribe = face.hooks.config.subscribe(() => {})
  face.edit('httpToken', 'tok-2')
  await face.save()
  assert.deepEqual(secretApi.setCalls, [['MY_ENGRAM_TOKEN', 'tok-2']])
  unsubscribe()
})

test('a blank token draft writes nothing — blank saves never clobber the stored secret', async () => {
  const { ctx, recorded, plugin, secretApi } = bootPlugin({ credentials: fakeCredentials({ ENGRAM_HTTP_TOKEN: 'kept' }) })
  plugin.apply(ctx)
  const face = recorded.registrations[0].declaration.inject()
  face.edit('httpToken', '   ')
  await face.save()
  assert.deepEqual(secretApi.setCalls, [])
  assert.equal(secretApi.store.ENGRAM_HTTP_TOKEN, 'kept')
})

test('a failed card build registers the dictionary but NO slot entry (containment)', () => {
  const { ctx, recorded, plugin } = bootPlugin()
  delete ctx.configForms // build throws before any registration
  plugin.apply(ctx)
  assert.equal(recorded.namespaces.length, 1)
  assert.equal(recorded.injects.length, 0)
  assert.equal(recorded.registrations.length, 0)
})

test('the card renders the shared chrome with the token secret field and cloud note', () => {
  const { ctx, recorded, plugin } = bootPlugin()
  plugin.apply(ctx)
  const { component } = recorded.registrations[0]
  const texts = []
  const t = (key) => key
  const state = {
    writable: true,
    httpToken: { text: '' },
    tokenConfigured: false,
    daemonMode: { text: 'auto-spawn' },
    port: { text: '' },
    autosync: { text: 'false' },
    projectMode: { text: 'auto' },
    fixedProject: { text: '' },
    projectMap: { text: '' },
    contextInjection: { text: 'off' },
    contextMaxBytes: { text: '2048' },
  }
  const tree = component({
    view: 'page',
    t,
    useConfig: () => state,
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
  })
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    // Fake-React elements carry the component FUNCTION as type; record its
    // name (string tags like 'p' record as-is).
    texts.push(typeof node.type === 'function' ? node.type.name : node.type)
    for (const child of node.children ?? []) walk(child)
    for (const field of ['httpToken', 'daemonMode', 'autosync']) {
      if (node.props?.state === state && node.props?.edit) texts.push(`field:${field}`)
    }
  }
  walk(tree)
  assert.ok(texts.includes('SettingsForm'))
  assert.ok(texts.includes('p'), 'cloud note paragraph renders')
  assert.ok(texts.includes('SettingsSecretField'), 'token renders through SettingsSecretField')
  assert.ok(texts.filter((name) => name === 'StagedField').length >= 6, 'value fields render as staged components over SettingsValueField')
  assert.equal(component({ view: 'summary', t, useConfig: () => state }), 'config.summary')
})
