/**
 * Browser-half contract tests.
 *
 * client.js is one self-contained script in the client module system's
 * factory format, so the suite boots it against a stub __ModuleLoader__,
 * feeds the factory a stub require (fake React + the primitives subset the
 * plugin uses — mirroring the real export set), and exercises the returned
 * cordis plugin: its registration surface against a STRICT ctx double (only
 * the injected services resolve; anything else throws, as cordis does), and
 * the spawn modal's data flow through a tiny hook harness with a fake
 * `remote.agentRoster` namespace.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Capture the load() registration the script performs on import. */
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
await import('../client.js')

/** Marker standing in for the shared Modal primitive (ui-primitives index.ts:51). */
function Modal(props) { return null }

/** Marker standing in for the shared plus icon (icons/index.tsx:82). */
function IconPlusOutlineRegular(props) { return null }

/** The primitives module the factory's require hands out: the real export names we consume. */
function primitives() {
  return { Modal, IconPlusOutlineRegular }
}

/**
 * Fake React: vdom-building createElement plus the hook subset the plugin
 * uses, and — beyond the airboard harness — recursive expansion of nested
 * component elements (the seat renders RosterModal, which renders Modal),
 * because real React invokes function components through the tree. Hook
 * state lives in the harness, so one harness == one component instance;
 * components that unmount keep their stale slots (no reopen flow is tested
 * here). `leaves` names shared-primitive marker components the harness must
 * NOT invoke, so their vdom nodes stay inspectable.
 */
function createHarness({ leaves = [] } = {}) {
  const leaf = new Set(leaves)
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
  /** Depth-first: invoke non-leaf component nodes, keep element/text nodes. */
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function' && !leaf.has(node.type)) return expand(node.type(node.props))
    return { ...node, children: (node.children ?? []).map(expand) }
  }
  return {
    React,
    /** One render pass: fresh hook cursor, fresh effect queue. */
    render(component, props) {
      last = { component, props }
      cursor = 0
      pending.length = 0
      return expand({ type: component, props, children: [] })
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

/**
 * Search one Modal marker node's body AND its footer prop tree: the shared
 * Modal takes the action row as a prop, so children-only walks miss it.
 */
function inModal(modal, predicate) {
  return find(modal, predicate) ?? find(modal.props.footer, predicate)
}

/**
 * A translating t that prefixes keys and, unlike airboard's, SURFACES params
 * — `t:key(k=v,…)` — so tests can prove a value (the spawned member's name)
 * reached the interpolating call rather than being dropped by the stub.
 */
function makeT() {
  return (key, params) => `t:${key}` + (params === undefined || Object.keys(params).length === 0
    ? ''
    : `(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`)
}

/** Flat key list of a locale dictionary, for zh/en parity. */
function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, inner]) => (
    typeof inner === 'object' && inner !== null ? keys(inner, `${prefix}${key}.`) : [`${prefix}${key}`]
  )).sort()
}

/** The {param} names a dictionary value interpolates, sorted. */
function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

/**
 * A cordis ctx double recording every registration the plugin makes, and
 * STRICT about services: only names the plugin declares in its inject list
 * resolve (commandUi / locale / slots / remote); any other service property
 * access throws, exactly like cordis ("cannot get property ... without
 * inject" — AGENTS.md fakes-must-replicate-real-strictness rule).
 * `roster` installs a fake `remote.agentRoster` namespace that ctx.get()
 * hands out once $mount runs (null / undefined = namespace absent).
 * `extras` installs additional client Remote faces under
 * `remote.<name>` (session, agentTeams, pluginInventory, pluginManager) the
 * way the real boot graph mounts them; they answer RemoteResult shapes —
 * `{ ok: true, value }` / `{ ok: false, error }` — mirroring the generated
 * faces' actual wire contract (ui-agent-team browser-plugin.client.spec.ts
 * :100-106), never a more forgiving shape.
 */
function makeCtx({ roster, extras, settings } = {}) {
  const recorded = { commands: [], injects: [], registers: [], namespaces: [], mounts: [], configKeys: [] }
  const remoteNamespaces = {}
  for (const [name, face] of Object.entries(extras ?? {})) remoteNamespaces[`remote.${name}`] = face
  // The fake ConfigForm mirrors the real contract (config-form.ts:104-160):
  // getSnapshot/subscribe for reads, queued set/unset/mutate for writes,
  // answered as RemoteResult. Values are plain JSON like the real mirror,
  // and accepted writes notify subscribers (mirror.acceptView → store →
  // listeners) so mounted readers re-read — a silent fake here made
  // disabled-state assertions pass for the wrong reason.
  const formValues = {
    draftEnabled: false,
    draftModelProvider: '',
    draftModelId: '',
    draftReasoningEffort: '',
    ...(settings ?? {}),
  }
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  const form = {
    writes: { sets: [], unsets: [], mutations: [] },
    getSnapshot: () => ({ status: 'ready', revision: 0, value: formValues }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, value) => { form.writes.sets.push([field, value]); formValues[field] = value; notify(); return true },
    unset: async (field) => { form.writes.unsets.push(field); delete formValues[field]; notify(); return true },
    mutate: async (ops) => {
      form.writes.mutations.push(ops)
      for (const op of ops) if (op.op === 'set') formValues[op.path[0]] = op.value
      notify()
      return true
    },
  }
  const services = {
    // The settings namespace is the LOADER ROW id 'agent-roster'
    // (settings/src/index.ts:315,327 ns: entry.options.id) — NOT the
    // package name. Strict: any other key resolves undefined, exactly
    // like the real configForms (the 2026-11-23 incident passed because
    // an earlier fake accepted the package name).
    configForms: {
      get: (id) => { recorded.configKeys.push(id); return id === 'agent-roster' ? form : undefined },
    },
    commandUi: { register: (contribution) => { recorded.commands.push(contribution); return () => {} } },
    locale: {
      bind: () => makeT(),
      register: (ns, dicts) => { recorded.namespaces.push({ ns, dicts }) },
    },
    slots: {
      inject: (name, begin) => { recorded.injects.push(name); return begin() },
      register: (declaration, Component) => { recorded.registers.push({ declaration, Component }); return () => {} },
    },
    remote: {
      $mount: (contribution) => {
        // Mirror the REAL gateway validation, not a more forgiving one
        // (AGENTS.md §1): dsh packages/api/gateway/src/client/index.ts
        // validateContribution (:283-330) — requireStrictInputs (:299-303 →
        // requireStrictCodec :341-346) rejects any parameter whose codec
        // mode is not 'strict', and duplicate (namespace, method) pairs
        // reject. The 2026-11-23 live incident: src-json parameter codecs
        // passed this fake and died at real mount, leaving the namespace
        // silently absent. The fake must reject first.
        const seen = new Set()
        for (const descriptor of contribution.descriptors) {
          const endpoint = `${descriptor.namespace}/${descriptor.method}`
          if (seen.has(endpoint)) {
            return Promise.reject(new Error(`client api: contribution repeats direct method ${endpoint}`))
          }
          seen.add(endpoint)
          for (const parameter of descriptor.parameters ?? []) {
            if (parameter.codec?.mode !== 'strict') {
              return Promise.reject(new Error(
                `client api: generated Remote ${contribution.package}#${endpoint} field ${JSON.stringify(parameter.wire)} has no strict codec`,
              ))
            }
          }
        }
        recorded.mounts.push(contribution)
        if (roster !== null && roster !== undefined) remoteNamespaces['remote.agentRoster'] = roster
        return Promise.resolve(() => {})
      },
    },
  }
  const ctx = new Proxy({
    effect(fn) { return fn() ?? undefined },
    // Real cordis semantics: get(name) resolves any service the plugin
    // injected. The namespaces the $mount installs land in remoteNamespaces;
    // injected client services (configForms) resolve from the services
    // table — returning undefined for configForms made the settings look
    // permanently 'loading' and let disabled-state tests pass for the
    // wrong reason.
    get(name) { return remoteNamespaces[name] ?? services[name] },
  }, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop]
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      if (Object.prototype.hasOwnProperty.call(services, prop)) return services[prop]
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
  return [ctx, recorded, form]
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

/** Boot the browser plugin against a fresh harness. */
function bootPlugin() {
  const harness = createHarness({ leaves: [Modal, IconPlusOutlineRegular] })
  const require = (specifier) => {
    if (specifier === 'react') return harness.React
    if (specifier === 'zod') {
      // Baseline module-table zod double: only `z.unknown()` is consumed
      // (lazily, by STRICT_JSON_CODEC.create) — the minimal parseable shape.
      return { z: { unknown: () => ({ safeParse: (value) => ({ success: true, data: value }) }) } }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives()
    throw new Error(`unexpected require: ${specifier}`)
  }
  return { harness, plugin: loaded[0].factory(require) }
}

/** Apply the plugin against a strict ctx and return the harness, the recordings, and the style node. */
function applyPlugin({ roster, extras, settings } = {}) {
  const { harness, plugin } = bootPlugin()
  const [ctx, recorded, form] = makeCtx({ roster, extras, settings })
  const style = { dataset: {}, textContent: '', remove() {} }
  withDocument(
    { createElement: () => style, head: { append() {} } },
    () => plugin.apply(ctx),
  )
  return { harness, recorded, style, form }
}

/** Two templates the fake roster serves. */
const TEMPLATES = [
  { id: 'tpl-researcher', name: 'Researcher', description: 'Finds and reads sources', prompt: 'You research topics thoroughly.', defaultModel: null, createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-20T08:00:00.000Z' },
  { id: 'tpl-reviewer', name: 'Reviewer', description: 'Reviews code diffs', prompt: 'You review diffs critically.', defaultModel: null, createdAt: '2026-11-21T08:00:00.000Z', updatedAt: '2026-11-21T08:00:00.000Z' },
]

/**
 * Boot, apply, mount the overlay seat, and open the modal through the
 * registered command's run(session) — the exact production path. Returns a
 * view over the seat's vdom (vdom + interact) plus the fake roster's
 * recorded spawn calls. `roster: null` leaves the remote namespace absent;
 * `extras` passes client Remote faces through to the ctx double;
 * `useProjection` installs a fake standard-props projection hook on the
 * seat (the plain-function shape ui-agent-team's team-mode.client.spec.tsx
 * :20 fakes; omitted = a host whose seat props predate the standard).
 */
async function openModal({ roster, extras, settings } = {}) {
  const spawned = []
  const rosterFake = roster === undefined
    ? {
      listTemplates: async () => ({ ok: true, value: TEMPLATES }),
      spawnMember: async (input) => { spawned.push(input); return { ok: true, value: { name: 'spawned-member' } } },
      // Healthy team: Team mode already on → the modal renders no banner.
      teamStatus: async () => ({ ok: true, value: { teamMode: true, isRoot: true, canEnable: true } }),
    }
    : roster
  // AI drafting defaults to ON with a configured model so the modal's draft
  // flows exercise their happy path; gating tests pass their own settings.
  const withDraft = { draftEnabled: true, draftModelProvider: 'deepseek', draftModelId: 'chat', ...(settings ?? {}) }
  const { harness, recorded, form } = applyPlugin({ roster: rosterFake, extras, settings: withDraft })
  const seat = recorded.registers.find(({ declaration }) => declaration.name === 'conversation.input.overlay')
  assert.ok(seat, 'the overlay seat is registered')
  const props = {
    t: makeT(),
    ...seat.declaration.inject('sess-1'),
  }
  const view = { vdom: undefined, spawned, harness, form }
  const render = () => { view.vdom = harness.render(seat.Component, props) }
  render()
  await harness.settle()
  render()
  /** Apply a gesture, let its promises settle, and re-render into view.vdom. */
  view.interact = async (gesture) => {
    if (gesture !== undefined) gesture()
    await harness.settle()
    render()
    return view.vdom
  }
  recorded.commands[0].ui.run({ sessionId: 'sess-1' })
  await view.interact()
  return view
}

test('client.js registers one module named dsh-agent-roster in the factory format', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-agent-roster')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('the factory returns a plugin injecting the documented services only', () => {
  const { plugin } = bootPlugin()
  assert.deepEqual(plugin.inject, ['commandUi', 'configForms', 'locale', 'slots', 'remote'])
  assert.equal(typeof plugin.apply, 'function')
})

test('boots and applies with an inject-only scope, registering command, seat, dictionaries, and scoped styles', () => {
  const { recorded, style } = applyPlugin()
  // Dictionaries: one namespace.
  assert.equal(recorded.namespaces.length, 1)
  assert.equal(recorded.namespaces[0].ns, 'agent-roster')
  // One commandUi contribution with kind action and localized copy.
  assert.equal(recorded.commands.length, 1)
  const command = recorded.commands[0]
  assert.equal(command.name, 'add-agent-member')
  assert.equal(command.ui.kind, 'action')
  assert.equal(typeof command.ui.run, 'function')
  assert.equal(typeof command.icon, 'function')
  assert.equal(command.available({ sessionId: 'sess-1' }), true)
  assert.equal(command.label(), 't:command.label')
  assert.equal(command.description(), 't:command.description')
  // One conversation.input.overlay seat (the ui-message-feedback placement).
  assert.ok(recorded.injects.includes('conversation.input.overlay'))
  const seat = recorded.registers.find(({ declaration }) => declaration.name === 'conversation.input.overlay')
  assert.ok(seat, 'the overlay seat is registered')
  assert.equal(seat.declaration.id, 'roster-modal')
  assert.equal(seat.declaration.locale, 'agent-roster')
  assert.equal(typeof seat.declaration.inject, 'function')
  assert.equal(typeof seat.Component, 'function')
  // Styles: injected once, scoped by attribute.
  assert.match(style.textContent, /\[data-agent-roster/)
})

test('locale dictionaries have zh/en key parity and interpolate {param}', () => {
  const { recorded } = applyPlugin()
  const { dicts } = recorded.namespaces[0]
  assert.deepEqual(keys(dicts.zh), keys(dicts.en))
  assert.ok(keys(dicts.zh).length >= 20)
  // Every value's {placeholder} set matches across languages.
  for (const [key, value] of Object.entries(dicts.zh)) {
    assert.deepEqual(placeholders(value), placeholders(dicts.en[key]), key)
  }
  // The success banner interpolates the spawned member's name.
  assert.deepEqual(placeholders(dicts.zh['spawn.success']), ['name'])
})

test('apply mounts the agentRoster remote namespace with all six method descriptors', () => {
  const { recorded } = applyPlugin()
  assert.equal(recorded.mounts.length, 1)
  const contribution = recorded.mounts[0]
  assert.equal(contribution.package, 'dsh-agent-roster')
  const byMethod = new Map(contribution.descriptors.map((descriptor) => [descriptor.method, descriptor]))
  assert.deepEqual([...byMethod.keys()].sort(),
    ['deleteTemplate', 'draft', 'listTemplates', 'saveTemplate', 'spawnMember', 'teamStatus'])
  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.id, `dsh-agent-roster#agentRoster/${descriptor.method}`)
    assert.equal(descriptor.service, 'agentRoster')
    assert.equal(descriptor.namespace, 'agentRoster')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    assert.deepEqual(descriptor.result, { mode: 'src-json' })
  }
  // The host signatures (lib/roster-service.js): object-input methods carry
  // their input parameter; deleteTemplate the id string; listTemplates none.
  // Every parameterized method carries the ONE frozen strict codec (the
  // src-json parameter codec was the 2026-11-23 live-mount failure; strict
  // is the gateway's requirement and the fake $mount now enforces it).
  const strictCodecs = new Set()
  for (const descriptor of contribution.descriptors) {
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict')
      assert.equal(parameter.codec.typeSymbol, '@local/dsh-agent-roster/json-value')
      assert.equal(typeof parameter.codec.create, 'function')
      strictCodecs.add(parameter.codec)
    }
  }
  assert.equal(strictCodecs.size, 1, 'one shared frozen codec instance')
  const inputParameter = (descriptor) => [{ name: 'input', wire: 'input', source: 'json', codec: descriptor.parameters[0].codec }]
  assert.deepEqual(byMethod.get('listTemplates').parameters, [])
  assert.deepEqual(byMethod.get('saveTemplate').parameters, inputParameter(byMethod.get('saveTemplate')))
  assert.deepEqual(byMethod.get('deleteTemplate').parameters,
    [{ name: 'id', wire: 'id', source: 'json', codec: byMethod.get('deleteTemplate').parameters[0].codec }])
  assert.deepEqual(byMethod.get('spawnMember').parameters, inputParameter(byMethod.get('spawnMember')))
  assert.deepEqual(byMethod.get('teamStatus').parameters, inputParameter(byMethod.get('teamStatus')))
  assert.deepEqual(byMethod.get('draft').parameters, inputParameter(byMethod.get('draft')))
})

test('run(session) opens the spawn modal through the overlay seat and cancel closes it', async () => {
  const view = await openModal()
  // The modal opened: shared chrome carries the localized title and close copy.
  const modal = find(view.vdom, (node) => node.type === Modal)
  assert.ok(modal, 'the modal is open')
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.title, 't:modal.title')
  assert.equal(modal.props.closeLabel, 't:modal.close')
  assert.equal(typeof modal.props.onClose, 'function')
  // Body sections render in the briefed order.
  const root = find(view.vdom, (node) => node.props?.['data-agent-roster'] !== undefined)
  assert.ok(root, 'the scoped root renders')
  assert.deepEqual(root.children.map((child) => child.props['data-agent-roster-section']),
    ['banner', 'templates', 'member-name', 'model', 'task', 'custom'])
  // The model selector is real since Task 7: enabled, with the
  // "current session model" inherit entry as its default option. No session
  // face is installed here, so the catalog-less degrade applies: one option.
  const modelSelect = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(modelSelect.type, 'select')
  assert.ok(modelSelect.props.disabled !== true)
  assert.equal(modelSelect.children.length, 1)
  assert.equal(modelSelect.children[0].props.value, '')
  assert.ok(texts(modelSelect.children[0]).includes('t:model.inherit'))
  // The custom-role toggle renders (its form is Task 7).
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-custom-toggle'] !== undefined))
  // Cancel (in the Modal footer prop) closes: no modal node remains.
  const cancel = inModal(modal, (node) => node.props?.['data-agent-roster-cancel'] !== undefined)
  await view.interact(() => { cancel.props.onClick() })
  assert.equal(find(view.vdom, (node) => node.type === Modal), undefined)
})

test('happy-path spawn: pick template, type task, confirm sends the exact payload and shows the success banner', async () => {
  const view = await openModal()
  // Templates render from listTemplates with the first auto-selected.
  const rows = findAll(view.vdom, (node) => typeof node.props?.['data-agent-roster-template'] === 'string')
  assert.deepEqual(rows.map((row) => row.props['data-agent-roster-template']), ['tpl-researcher', 'tpl-reviewer'])
  assert.equal(rows[0].props['aria-selected'], 'true')
  assert.equal(rows[1].props['aria-selected'], 'false')
  assert.ok(texts(rows[0]).includes('Researcher'))
  // Type a first task; leave the member name blank.
  const task = find(view.vdom, (node) => node.props?.['data-agent-roster-task'] !== undefined)
  assert.equal(task.type, 'textarea')
  await view.interact(() => { task.props.onChange({ target: { value: 'Survey the market for rivals' } }) })
  // Confirm (in the Modal footer prop): the exact spawnMember wire input, model null = inherit.
  const modal = find(view.vdom, (node) => node.type === Modal)
  const confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  await view.interact(() => { confirm.props.onClick() })
  assert.deepEqual(view.spawned, [{
    sessionId: 'sess-1',
    templateId: 'tpl-researcher',
    model: null,
    task: 'Survey the market for rivals',
  }])
  // Success banner interpolates the spawned member's name; the modal stays open.
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'success')
  assert.ok(texts(banner).join(' ').includes('t:spawn.success(name=spawned-member)'))
  assert.ok(find(view.vdom, (node) => node.type === Modal))
})

test('spawn failure renders the bilingual error line with whatever code arrived', async () => {
  const view = await openModal({ roster: {
    listTemplates: async () => ({ ok: true, value: TEMPLATES }),
    // A NON-roster typed error (SubagentError shape: code + message) must
    // render as-is — the client never assumes roster/* codes.
    spawnMember: async () => {
      throw Object.assign(new Error('member name rejected / 成员名称被拒绝'), { code: 'INVALID' })
    },
  } })
  const modal = find(view.vdom, (node) => node.type === Modal)
  const confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  await view.interact(() => { confirm.props.onClick() })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'error')
  assert.ok(banner, 'the error banner renders')
  assert.equal(banner.props['data-agent-roster-error'], 'INVALID')
  const line = texts(banner).join(' ')
  assert.ok(line.includes('t:spawn.failed'))
  assert.ok(line.includes('INVALID — member name rejected / 成员名称被拒绝'))
  // The modal stays open and the confirm re-enables for a retry.
  const modalAfter = find(view.vdom, (node) => node.type === Modal)
  assert.ok(modalAfter)
  const confirmAfter = inModal(modalAfter, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  assert.equal(confirmAfter.props.disabled, false)
})

test('a missing roster namespace degrades to the unavailable line, never a crash', async () => {
  const view = await openModal({ roster: null })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'unavailable')
  assert.ok(note)
  assert.ok(texts(note).join(' ').includes('t:templates.unavailable'))
  // No selection is possible, so confirm stays disabled.
  const modal = find(view.vdom, (node) => node.type === Modal)
  const confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  assert.equal(confirm.props.disabled, true)
})

test('a failed template load renders the error line with the upstream message', async () => {
  const view = await openModal({ roster: {
    listTemplates: async () => { throw Object.assign(new Error('store read failed / 存储读取失败'), { code: 'roster/store-read' }) },
    spawnMember: async () => ({ ok: true, value: { name: 'x' } }),
  } })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'error')
  assert.ok(note)
  const line = texts(note).join(' ')
  assert.ok(line.includes('t:templates.error'))
  assert.ok(line.includes('roster/store-read — store read failed / 存储读取失败'))
  const modal = find(view.vdom, (node) => node.type === Modal)
  assert.equal(inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.disabled, true)
})

// ---------------------------------------------------------------------------
// Task 7 — modal completeness: custom role, AI draft, model selector, gating.
// ---------------------------------------------------------------------------

/** Healthy team status: Team mode on, so no banner renders. */
const HEALTHY_TEAM = { teamMode: true, isRoot: true, canEnable: true }

/** One provider-grouped catalog the fake session face serves (session-controller types.ts:103-135). */
const CATALOG = {
  default: { provider: 'deepseek', model: 'chat' },
  routableProviders: ['deepseek'],
  groups: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'chat', name: 'DeepSeek Chat' },
      { id: 'reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
    ],
  }],
  failures: [],
}

/** A roster fake with a controllable teamStatus and recording spawn/save. */
function rosterWithTeam(status, record = { spawned: [], saved: [], drafted: [] }) {
  return {
    listTemplates: async () => ({ ok: true, value: TEMPLATES }),
    spawnMember: async (input) => { record.spawned.push(input); return { ok: true, value: { name: 'spawned-member' } } },
    saveTemplate: async (input) => { record.saved.push(input); return { ok: true, value: { id: 'tpl-new', ...input } } },
    draft: async (input) => { record.drafted.push(input); return { ok: true, value: { name: 'Drafted', description: 'Drafted role', prompt: 'You were drafted.', parsed: true } } },
    teamStatus: async (input) => ({ ok: true, value: typeof status === 'function' ? status(input) : status }),
  }
}

/** Flip the custom-role toggle on. */
async function enableCustomRole(view) {
  const toggle = find(view.vdom, (node) => node.props?.['data-agent-roster-custom-toggle'] !== undefined)
  await view.interact(() => { toggle.props.onChange({ target: { checked: true } }) })
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-custom-form'] !== undefined), 'the custom form renders')
}

/** Type into one field marked with a data-agent-roster-* attribute (checkbox-safe). */
async function typeInto(view, marker, value) {
  const field = find(view.vdom, (node) => node.props?.[marker] !== undefined)
  assert.ok(field, `${marker} renders`)
  await view.interact(() => { field.props.onChange({ target: { value, checked: value } }) })
}

test('custom spawn payload (custom xor templateId)', async () => {
  const record = { spawned: [], saved: [], drafted: [] }
  const view = await openModal({ roster: rosterWithTeam(HEALTHY_TEAM, record) })
  await enableCustomRole(view)
  // Incomplete custom form: confirm disabled with an explanatory hint.
  let modal = find(view.vdom, (node) => node.type === Modal)
  let confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  assert.equal(confirm.props.disabled, true)
  let hint = find(view.vdom, (node) => node.props?.['data-agent-roster-confirm-hint'] !== undefined)
  assert.ok(hint, 'a hint renders while confirm is disabled')
  assert.ok(texts(hint).join(' ').includes('t:custom.incomplete'))
  // Fill name, prompt, description → hint gone, confirm enabled.
  await typeInto(view, 'data-agent-roster-role-name', 'Market Scout')
  await typeInto(view, 'data-agent-roster-role-prompt', 'You scout markets.')
  await typeInto(view, 'data-agent-roster-role-description', 'Scans markets')
  modal = find(view.vdom, (node) => node.type === Modal)
  confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  assert.equal(confirm.props.disabled, false)
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-confirm-hint'] !== undefined), undefined)
  await view.interact(() => { confirm.props.onClick() })
  // custom xor templateId: the payload carries custom and NO templateId key.
  assert.equal(record.spawned.length, 1)
  assert.equal('templateId' in record.spawned[0], false)
  assert.deepEqual(record.spawned[0], {
    sessionId: 'sess-1',
    custom: { name: 'Market Scout', description: 'Scans markets', prompt: 'You scout markets.' },
    model: null,
  })
  // The save-as-template box was unchecked: nothing was saved.
  assert.deepEqual(record.saved, [])
})

test('draft fills form, save happens only on confirm', async () => {
  const record = { spawned: [], saved: [], drafted: [] }
  const order = []
  const view = await openModal({ roster: {
    ...rosterWithTeam(HEALTHY_TEAM, record),
    spawnMember: async (input) => { order.push(['spawn', input]); return { ok: true, value: { name: 'market-scout' } } },
    saveTemplate: async (input) => { order.push(['save', input]); return { ok: true, value: { id: 'tpl-x', ...input } } },
    draft: async (input) => { record.drafted.push(input); return { ok: true, value: { name: 'Market Scout', description: 'Scans markets', prompt: 'You scan markets.', parsed: true } } },
  } })
  await enableCustomRole(view)
  await typeInto(view, 'data-agent-roster-brief', 'A role that scans markets')
  // Draft: exact wire payload, model null = keep the draft session's own.
  const draftButton = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  await view.interact(() => { draftButton.props.onClick() })
  assert.deepEqual(record.drafted, [{ sessionId: 'sess-1', brief: 'A role that scans markets', model: null }])
  // The result filled the FORM FIELDS ONLY — nothing was saved or spawned.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-name'] !== undefined).props.value, 'Market Scout')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-description'] !== undefined).props.value, 'Scans markets')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-prompt'] !== undefined).props.value, 'You scan markets.')
  assert.deepEqual(order, [])
  // Explicit confirm with save-as-template checked: saveTemplate BEFORE the
  // custom spawn (a save failure must surface while still fixable in-form).
  await typeInto(view, 'data-agent-roster-save-template', true)
  const modal = find(view.vdom, (node) => node.type === Modal)
  const confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  await view.interact(() => { confirm.props.onClick() })
  assert.deepEqual(order.map(([kind]) => kind), ['save', 'spawn'])
  assert.deepEqual(order[0][1], { name: 'Market Scout', description: 'Scans markets', prompt: 'You scan markets.', defaultModel: null })
  assert.equal('templateId' in order[1][1], false)
  assert.deepEqual(order[1][1].custom, { name: 'Market Scout', description: 'Scans markets', prompt: 'You scan markets.' })
})

test('an unparsed draft is visibly flagged and leaves confirm gated', async () => {
  const view = await openModal({ roster: {
    ...rosterWithTeam(HEALTHY_TEAM),
    draft: async () => ({ ok: true, value: { name: '', description: '', prompt: 'not json at all', parsed: false } }),
  } })
  await enableCustomRole(view)
  await typeInto(view, 'data-agent-roster-brief', 'Make a role')
  const draftButton = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  await view.interact(() => { draftButton.props.onClick() })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'draft-unparsed')
  assert.ok(note, 'the unparsed flag renders')
  assert.ok(texts(note).join(' ').includes('t:draft.unparsed'))
  // The raw text landed in prompt; name stays empty so confirm stays gated.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-prompt'] !== undefined).props.value, 'not json at all')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-name'] !== undefined).props.value, '')
  const modal = find(view.vdom, (node) => node.type === Modal)
  assert.equal(inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.disabled, true)
})

test('model selector lists catalog with current-model default; explicit choice sends ModelRef, default sends null', async () => {
  const record = { spawned: [], saved: [], drafted: [] }
  const view = await openModal({
    roster: rosterWithTeam(HEALTHY_TEAM, record),
    extras: { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } },
  })
  const select = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(select.type, 'select')
  assert.ok(select.props.disabled !== true)
  assert.equal(select.props['data-agent-roster-model'], 'inherit')
  assert.equal(select.props.value, '')
  // Default entry first, then provider-grouped catalog models.
  assert.equal(select.children[0].type, 'option')
  assert.equal(select.children[0].props.value, '')
  assert.ok(texts(select.children[0]).includes('t:model.inherit'))
  const group = select.children.find((child) => child.type === 'optgroup')
  assert.ok(group, 'catalog models render inside provider groups')
  assert.equal(group.props.label, 'DeepSeek')
  assert.deepEqual(group.children.map((option) => option.props.value),
    [JSON.stringify(['deepseek', 'chat']), JSON.stringify(['deepseek', 'reasoner'])])
  // Default: confirm sends model null (explicit inherit).
  let modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.equal(record.spawned[0].model, null)
  // Explicit reasoning model: the effort input appears beside it only now.
  await view.interact(() => { select.props.onChange({ target: { value: JSON.stringify(['deepseek', 'reasoner']) } }) })
  const effort = find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined)
  assert.ok(effort, 'the effort input renders beside an explicit reasoning model')
  assert.deepEqual(effort.children.map((option) => option.props.value), ['', 'low', 'high'])
  await view.interact(() => { effort.props.onChange({ target: { value: 'high' } }) })
  modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.deepEqual(record.spawned[1].model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
  // A model without reasoning metadata: no effort input, no reasoningEffort key.
  const selectAgain = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  await view.interact(() => { selectAgain.props.onChange({ target: { value: JSON.stringify(['deepseek', 'chat']) } }) })
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined), undefined)
  modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.deepEqual(record.spawned[2].model, { provider: 'deepseek', model: 'chat' })
})

test('a failed or absent modelCatalog degrades to the inherit-only selector and never blocks spawn', async () => {
  const record = { spawned: [], saved: [], drafted: [] }
  // Absent face (no session remote at all).
  const view = await openModal({ roster: rosterWithTeam(HEALTHY_TEAM, record) })
  let select = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.ok(select.props.disabled !== true)
  assert.equal(select.children.length, 1)
  assert.ok(texts(select.children[0]).includes('t:model.inherit'))
  let modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.equal(record.spawned[0].model, null)
  // A not-ok RemoteResult degrades the same way.
  const record2 = { spawned: [], saved: [], drafted: [] }
  const view2 = await openModal({
    roster: rosterWithTeam(HEALTHY_TEAM, record2),
    extras: { session: { modelCatalog: async () => ({ ok: false, error: { code: 'session/provider-models-unavailable', message: 'no key' } }) } },
  })
  select = find(view2.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(select.children.length, 1)
  modal = find(view2.vdom, (node) => node.type === Modal)
  await view2.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.equal(record2.spawned[0].model, null)
  // A rejecting call degrades the same way.
  const record3 = { spawned: [], saved: [], drafted: [] }
  const view3 = await openModal({
    roster: rosterWithTeam(HEALTHY_TEAM, record3),
    extras: { session: { modelCatalog: async () => { throw Object.assign(new Error('gateway down'), { code: 'gateway/internal' }) } } },
  })
  select = find(view3.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(select.children.length, 1)
  modal = find(view3.vdom, (node) => node.type === Modal)
  await view3.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.equal(record3.spawned[0].model, null)
})

test('enable button appears only when canEnable && !teamMode, calls setEnabled then refreshes', async () => {
  // Healthy (teamMode true): no banner at all, so no button either.
  const healthy = await openModal()
  assert.equal(find(healthy.vdom, (node) => node.props?.['data-agent-roster-team'] !== undefined), undefined)
  // canEnable && !teamMode: explanation plus the Enable button.
  const enabled = []
  const teamCalls = []
  const view = await openModal({
    roster: {
      ...rosterWithTeam(HEALTHY_TEAM),
      teamStatus: async (input) => { teamCalls.push(input); return { ok: true, value: { teamMode: false, isRoot: true, canEnable: true } } },
    },
    extras: { agentTeams: { setEnabled: async (sessionId, on) => { enabled.push([sessionId, on]); return { ok: true, value: undefined } } } },
  })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-team'] !== undefined)
  assert.equal(banner.props['data-agent-roster-team'], 'enable')
  assert.ok(texts(banner).join(' ').includes('t:team.enable.explain'))
  const button = find(banner, (node) => node.props?.['data-agent-roster-team-enable'] !== undefined)
  assert.ok(button, 'the Enable button renders')
  // Click → setEnabled(sessionId, true), then teamStatus re-read (refresh).
  const before = teamCalls.length
  await view.interact(() => { button.props.onClick() })
  assert.deepEqual(enabled, [['sess-1', true]])
  assert.deepEqual(teamCalls.slice(before), [{ sessionId: 'sess-1' }], 'teamStatus is re-read after enabling')
})

test('non-root shows explanation and no button', async () => {
  const view = await openModal({
    roster: rosterWithTeam({ teamMode: false, isRoot: false, canEnable: false }),
    extras: {
      agentTeams: { setEnabled: async () => { throw new Error('must not be called') } },
      pluginManager: { setPluginEnabled: async () => { throw new Error('must not be called') } },
    },
  })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-team'] !== undefined)
  assert.equal(banner.props['data-agent-roster-team'], 'nonroot')
  assert.ok(texts(banner).join(' ').includes('t:team.nonroot'))
  assert.equal(find(banner, (node) => node.props?.['data-agent-roster-team-enable'] !== undefined), undefined)
  assert.equal(find(banner, (node) => node.props?.['data-agent-roster-team-rows'] !== undefined), undefined)
})

test('rows-disabled offers enable for both rows after confirm', async () => {
  const toggles = []
  const lists = []
  const teamCalls = []
  const view = await openModal({
    roster: {
      ...rosterWithTeam(() => { teamCalls.push(1); return { teamMode: false, isRoot: true, canEnable: false } }),
    },
    extras: {
      pluginInventory: { list: async () => { lists.push(1); return { ok: true, value: { entries: [
        { entryId: 'agent-team', moduleName: '@deepseek-ai/dsh-agent-team', enabled: false },
        { entryId: 'tool-agent-team', moduleName: '@deepseek-ai/dsh-tool-agent-team', enabled: false },
        { entryId: 'llm-deepseek', moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key', enabled: true },
      ], managementAvailable: true } } } },
      pluginManager: { setPluginEnabled: async (entryId, on) => { toggles.push([entryId, on]); return { ok: true, value: { application: 'applied' } } } },
    },
  })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-team'] !== undefined)
  assert.equal(banner.props['data-agent-roster-team'], 'rows')
  assert.ok(texts(banner).join(' ').includes('t:team.rows.explain'))
  const button = find(banner, (node) => node.props?.['data-agent-roster-team-rows'] !== undefined)
  assert.ok(button)
  assert.ok(texts(button).includes('t:team.rows.action'))
  // First click arms the confirmation only; nothing toggles yet.
  await view.interact(() => { button.props.onClick() })
  assert.deepEqual(toggles, [])
  const armed = find(view.vdom, (node) => node.props?.['data-agent-roster-team-rows'] !== undefined)
  assert.ok(texts(armed).includes('t:team.rows.confirm'))
  // Second click enables BOTH rows and refreshes status + inventory.
  await view.interact(() => { armed.props.onClick() })
  assert.deepEqual(toggles, [['agent-team', true], ['tool-agent-team', true]])
  assert.ok(lists.length >= 2, 'the inventory is re-read after enabling')
  assert.ok(teamCalls.length >= 2, 'teamStatus is re-read after enabling')
})

test('absent remote shows guidance without throwing', async () => {
  // Roster namespace absent entirely: guidance text, no buttons, no crash.
  const view = await openModal({ roster: null })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-team'] !== undefined)
  assert.equal(banner.props['data-agent-roster-team'], 'guidance')
  assert.ok(texts(banner).join(' ').includes('t:team.guidance'))
  assert.equal(find(banner, (node) => node.props?.['data-agent-roster-team-enable'] !== undefined), undefined)
  assert.equal(find(banner, (node) => node.props?.['data-agent-roster-team-rows'] !== undefined), undefined)
  // canEnable but no agentTeams client face: the button cannot work, so the
  // banner degrades to guidance text only.
  const view2 = await openModal({ roster: rosterWithTeam({ teamMode: false, isRoot: true, canEnable: true }) })
  const banner2 = find(view2.vdom, (node) => node.props?.['data-agent-roster-team'] !== undefined)
  assert.equal(banner2.props['data-agent-roster-team'], 'guidance')
  assert.equal(find(banner2, (node) => node.props?.['data-agent-roster-team-enable'] !== undefined), undefined)
})

test('modal close is gated while a spawn or draft is in flight', async () => {
  // Spawn in flight: Escape/mask close (onClose) and Cancel are gated.
  let resolveSpawn
  const view = await openModal({ roster: {
    ...rosterWithTeam(HEALTHY_TEAM),
    spawnMember: () => new Promise((resolve) => { resolveSpawn = resolve }),
  } })
  let modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  modal = find(view.vdom, (node) => node.type === Modal)
  assert.ok(modal)
  assert.equal(inModal(modal, (node) => node.props?.['data-agent-roster-cancel'] !== undefined).props.disabled, true)
  modal.props.onClose()
  await view.interact()
  assert.ok(find(view.vdom, (node) => node.type === Modal), 'the modal survives close while spawning')
  resolveSpawn({ ok: true, value: { name: 'late-member' } })
  await view.interact()
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'success'), 'the in-flight result lands')
  modal = find(view.vdom, (node) => node.type === Modal)
  modal.props.onClose()
  await view.interact()
  assert.equal(find(view.vdom, (node) => node.type === Modal), undefined, 'close works again once settled')
  // Draft in flight: gated the same way.
  let resolveDraft
  const view2 = await openModal({ roster: {
    ...rosterWithTeam(HEALTHY_TEAM),
    draft: () => new Promise((resolve) => { resolveDraft = resolve }),
  } })
  await enableCustomRole(view2)
  await typeInto(view2, 'data-agent-roster-brief', 'Make a role')
  const draftButton = find(view2.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  await view2.interact(() => { draftButton.props.onClick() })
  let modal2 = find(view2.vdom, (node) => node.type === Modal)
  modal2.props.onClose()
  await view2.interact()
  assert.ok(find(view2.vdom, (node) => node.type === Modal), 'the modal survives close while drafting')
  resolveDraft({ ok: true, value: { name: 'Late', description: 'd', prompt: 'p', parsed: true } })
  await view2.interact()
  assert.equal(find(view2.vdom, (node) => node.props?.['data-agent-roster-role-name'] !== undefined).props.value, 'Late')
})

test('draft button disabled while drafting; stop abandons the wait and discards the late answer', async () => {  let resolveDraft
  const drafted = []
  const view = await openModal({ roster: {
    ...rosterWithTeam(HEALTHY_TEAM, { spawned: [], saved: [], drafted }),
    draft: (input) => { drafted.push(input); return new Promise((resolve) => { resolveDraft = resolve }) },
  } })
  await enableCustomRole(view)
  await typeInto(view, 'data-agent-roster-brief', 'Make me a role')
  const draftButton = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  await view.interact(() => { draftButton.props.onClick() })
  // In flight: the Draft button is disabled (one draft session per cwd) and
  // the stop control appears.
  const inFlight = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  assert.equal(inFlight.props.disabled, true)
  assert.ok(texts(inFlight).includes('t:draft.inflight'))
  const stop = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-abort'] !== undefined)
  assert.ok(stop)
  // Stop: the wait is abandoned; a second draft could start.
  await view.interact(() => { stop.props.onClick() })
  const after = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  assert.equal(after.props.disabled, false)
  assert.ok(texts(after).includes('t:draft.action'))
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'draft-aborted'))
  // The late answer is discarded: the fields stay empty, nothing crashes.
  resolveDraft({ ok: true, value: { name: 'Late', description: 'd', prompt: 'p', parsed: true } })
  await view.interact()
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-name'] !== undefined).props.value, '')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-prompt'] !== undefined).props.value, '')
})

test('a failed draft renders its error line inline and re-enables the Draft button', async () => {
  const view = await openModal({ roster: {
    ...rosterWithTeam(HEALTHY_TEAM),
    draft: async () => ({ ok: false, error: { code: 'roster/draft-timeout', message: 'The draft turn did not finish / 草稿生成未完成' } }),
  } })
  await enableCustomRole(view)
  await typeInto(view, 'data-agent-roster-brief', 'Make a role')
  const draftButton = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  await view.interact(() => { draftButton.props.onClick() })
  const error = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-error'] !== undefined)
  assert.ok(error, 'the draft error line renders')
  assert.equal(error.props['data-agent-roster-error'], 'roster/draft-timeout')
  const line = texts(error).join(' ')
  assert.ok(line.includes('t:draft.failed'))
  assert.ok(line.includes('roster/draft-timeout — The draft turn did not finish / 草稿生成未完成'))
  // Nothing filled; the button is re-armed for a retry.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-name'] !== undefined).props.value, '')
  const retry = find(view.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  assert.equal(retry.props.disabled, false)
})

test('a failed team action renders the action-failed line without losing the banner', async () => {
  const view = await openModal({
    roster: rosterWithTeam({ teamMode: false, isRoot: true, canEnable: true }),
    extras: { agentTeams: { setEnabled: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'connection failed' } }) } },
  })
  const button = find(view.vdom, (node) => node.props?.['data-agent-roster-team-enable'] !== undefined)
  assert.ok(button)
  await view.interact(() => { button.props.onClick() })
  const error = find(view.vdom, (node) => node.props?.['data-agent-roster-team'] === 'error')
  assert.ok(error, 'the team action-failed line renders')
  const line = texts(error).join(' ')
  assert.ok(line.includes('t:team.actionFailed'))
  assert.ok(line.includes('gateway/internal — connection failed'))
  // The enable banner stays for a retry.
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-team'] === 'enable'))
})

/** The fake session face serving the catalog. */
const catalogFace = () => ({ ok: true, value: CATALOG })

test('the draft area follows the Settings configuration, never a per-draft picker', async () => {
  const drafted = []
  const roster = {
    listTemplates: async () => ({ ok: true, value: TEMPLATES }),
    spawnMember: async () => ({ ok: true, value: { name: 'x' } }),
    teamStatus: async () => ({ ok: true, value: { teamMode: true, isRoot: true, canEnable: true } }),
    draft: async (input) => { drafted.push(input); return { ok: true, value: { name: 'D', description: 'd', prompt: 'p', parsed: true } } },
  }
  // Disabled → configure hint, button disabled, no draft possible.
  const off = await openModal({ roster, settings: { draftEnabled: false } })
  await enableCustomRole(off)
  const offLine = find(off.vdom, (node) => node.props?.['data-agent-roster-draft-model-line'] === 'configure')
  assert.ok(offLine, 'the configure-first hint renders')
  assert.ok(texts(offLine).includes('t:draft.configure.hint'))
  const offButton = find(off.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined)
  assert.equal(offButton.props.disabled, true)
  // Enabled without a model → still the configure hint (enabling requires
  // picking a model — the 2026-11-23 ruling).
  const unconfigured = await openModal({ roster, settings: { draftEnabled: true, draftModelProvider: '', draftModelId: '' } })
  await enableCustomRole(unconfigured)
  assert.ok(find(unconfigured.vdom, (node) => node.props?.['data-agent-roster-draft-model-line'] === 'configure'))
  assert.equal(find(unconfigured.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined).props.disabled, true)
  // Enabled + configured → the uses line names the model and the draft
  // sends model: null (Settings owns the model; the host resolves it).
  const on = await openModal({ roster, settings: { draftEnabled: true, draftModelProvider: 'deepseek', draftModelId: 'chat' } })
  await enableCustomRole(on)
  const uses = find(on.vdom, (node) => node.props?.['data-agent-roster-draft-model-line'] === 'ready')
  assert.ok(uses, 'the uses line renders')
  assert.ok(texts(uses).includes('t:draft.uses(model=chat)'))
  await typeInto(on, 'data-agent-roster-brief', 'A role')
  await on.interact(() => { find(on.vdom, (node) => node.props?.['data-agent-roster-draft'] !== undefined).props.onClick() })
  assert.deepEqual(drafted, [{ sessionId: 'sess-1', brief: 'A role', model: null }])
})


// ---------------------------------------------------------------------------
// Task 8 — Plugins-page settings card (roster manager).
// ---------------------------------------------------------------------------

/**
 * The section contract (verified in the checkout): `settings.section` is a
 * list ROOT-scope slot whose entries render through the Settings page's
 * `settings.section.view` factory with `{ id, close }` owner props
 * (packages/client/ui-settings/src/client/contract/slots.ts:17-27; the
 * ui-settings-models registration precedent client/index.ts:143-152).
 * mountSection therefore renders the registered component with `{ t }`
 * alone — no session identity exists on this surface.
 */
async function mountSection({ roster, extras, settings } = {}) {

  const calls = { saved: [], deleted: [], listed: 0 }
  const rosterFake = roster === undefined ? {
    listTemplates: async () => { calls.listed += 1; return { ok: true, value: CARD_TEMPLATES } },
    saveTemplate: async (input) => { calls.saved.push(input); return { ok: true, value: { id: input?.id ?? 'tpl-new', ...input } } },
    deleteTemplate: async (id) => { calls.deleted.push(id); return { ok: true, value: { deleted: true } } },
  } : roster
  const { harness, recorded, form } = applyPlugin({ roster: rosterFake, extras, settings })
  const section = recorded.registers.find(({ declaration }) => declaration.name === 'settings.section')
  assert.ok(section, 'the settings section is registered')
  const seatProps = { t: makeT() }
  const view = { vdom: undefined, calls, harness, form, recorded }
  const render = () => { view.vdom = harness.render(section.Component, seatProps) }
  render()
  await harness.settle()
  render()
  view.interact = async (gesture) => {
    if (gesture !== undefined) gesture()
    await harness.settle()
    render()
    return view.vdom
  }
  return view
}

/** Templates the card fake serves: one without and one with a default model. */
const CARD_TEMPLATES = [
  { id: 'tpl-researcher', name: 'Researcher', description: 'Finds and reads sources', prompt: 'You research topics thoroughly.', defaultModel: null, createdAt: '2026-11-19T08:00:00.000Z', updatedAt: '2026-11-20T08:00:00.000Z' },
  { id: 'tpl-scout', name: 'Market Scout', description: 'Scans markets', prompt: 'You scan markets.', defaultModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }, createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-21T10:00:00.000Z' },
]

test('the roster manager registers one settings.section entry', () => {
  const { recorded } = applyPlugin()
  assert.ok(recorded.injects.includes('settings.section'))
  const section = recorded.registers.find(({ declaration }) => declaration.name === 'settings.section')
  assert.ok(section, 'the settings section is registered')
  assert.equal(section.declaration.id, 'agent-roster')
  assert.equal(section.declaration.order, 40)
  assert.equal(section.declaration.locale, 'agent-roster')
  assert.equal(typeof section.declaration.label, 'function')
  assert.equal(section.declaration.label(), 't:settings.nav')
  assert.equal(typeof section.Component, 'function')
  // The Plugins-page card is GONE: the row shows the settings entry instead
  // (the shell lists a bundle row's section when it registers no config).
  assert.equal(recorded.injects.includes('plugins.bundle.config'), false)
})

test('card renders records from listTemplates with model chip and updatedAt', async () => {
  const view = await mountSection()
  const rows = findAll(view.vdom, (node) => typeof node.props?.['data-agent-roster-row'] === 'string')
  assert.deepEqual(rows.map((row) => row.props['data-agent-roster-row']), ['tpl-researcher', 'tpl-scout'])
  const first = rows[0]
  assert.ok(texts(find(first, (node) => node.props?.['data-agent-roster-row-name'] !== undefined)).includes('Researcher'))
  assert.ok(texts(find(first, (node) => node.props?.['data-agent-roster-row-desc'] !== undefined)).includes('Finds and reads sources'))
  assert.ok(texts(find(first, (node) => node.props?.['data-agent-roster-row-model'] !== undefined)).includes('t:card.model.none'))
  assert.ok(texts(find(first, (node) => node.props?.['data-agent-roster-row-updated'] !== undefined)).join(' ')
    .includes('t:card.updatedAt(time=2026-11-20T08:00:00.000Z)'))
  const second = rows[1]
  const chip = find(second, (node) => node.props?.['data-agent-roster-row-model'] !== undefined)
  assert.ok(texts(chip).join(' ').includes('t:card.model.chip.effort(provider=deepseek,model=reasoner,effort=high)'))
  // Every row carries edit + delete controls; the header carries the add one.
  assert.ok(find(second, (node) => node.props?.['data-agent-roster-row-edit'] === 'tpl-scout'))
  assert.ok(find(second, (node) => node.props?.['data-agent-roster-row-delete'] === 'tpl-scout'))
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined))
})

test('card edit prefills the shared fields and saves through saveTemplate with id', async () => {
  const view = await mountSection({ extras: { session: { modelCatalog: catalogFace } } })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-row-edit'] === 'tpl-scout').props.onClick()
  })
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined), 'the edit form opens')
  // Prefill: the shared role fields and the default-model editor + effort.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-name'] !== undefined).props.value, 'Market Scout')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-description'] !== undefined).props.value, 'Scans markets')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-role-prompt'] !== undefined).props.value, 'You scan markets.')
  const model = find(view.vdom, (node) => node.props?.['data-agent-roster-card-model'] !== undefined)
  assert.equal(model.props.value, JSON.stringify(['deepseek', 'reasoner']))
  assert.equal(model.props['data-agent-roster-card-model'], JSON.stringify(['deepseek', 'reasoner']))
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined).props.value, 'high')
  // Edit the description; switch the default model to one without efforts.
  await typeInto(view, 'data-agent-roster-role-description', 'Scans rival markets')
  await view.interact(() => { model.props.onChange({ target: { value: JSON.stringify(['deepseek', 'chat']) } }) })
  const save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  // The wire payload: the id, kept fields, the edited description, and the
  // new explicit defaultModel (the model switch cleared the effort).
  assert.deepEqual(view.calls.saved, [{
    id: 'tpl-scout',
    name: 'Market Scout',
    description: 'Scans rival markets',
    prompt: 'You scan markets.',
    defaultModel: { provider: 'deepseek', model: 'chat' },
  }])
  // The form closes and the list refreshes after the save.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined), undefined)
  assert.ok(view.calls.listed >= 2, 'the list is re-read after saving')
})

test('card edit keeps an unmapped default model losslessly when the catalog is absent', async () => {
  const view = await mountSection()
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-row-edit'] === 'tpl-scout').props.onClick()
  })
  // No catalog rows: the stored ref rides as a synthetic option, effort kept.
  const model = find(view.vdom, (node) => node.props?.['data-agent-roster-card-model'] !== undefined)
  assert.equal(model.props.value, JSON.stringify(['deepseek', 'reasoner']))
  const effort = find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined)
  assert.equal(effort.props.value, 'high')
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined).props.onClick()
  })
  assert.deepEqual(view.calls.saved[0].defaultModel, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('card add form gates on name+prompt, defaults to no model, and sends no id', async () => {
  const view = await mountSection({ extras: { session: { modelCatalog: catalogFace } } })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined).props.onClick()
  })
  // The default-model editor defaults to none with its own labeled entry.
  const model = find(view.vdom, (node) => node.props?.['data-agent-roster-card-model'] !== undefined)
  assert.equal(model.props.value, '')
  assert.equal(model.props['data-agent-roster-card-model'], 'none')
  assert.ok(texts(model.children[0]).includes('t:card.model.none'))
  // Save gated with the explanatory hint until name+prompt are set.
  let save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  assert.equal(save.props.disabled, true)
  assert.ok(texts(find(view.vdom, (node) => node.props?.['data-agent-roster-card-save-hint'] !== undefined)).includes('t:card.incomplete'))
  await typeInto(view, 'data-agent-roster-role-name', 'Librarian')
  await typeInto(view, 'data-agent-roster-role-prompt', 'You keep the library.')
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-model'] !== undefined)
      .props.onChange({ target: { value: JSON.stringify(['deepseek', 'reasoner']) } })
  })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined)
      .props.onChange({ target: { value: 'low' } })
  })
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-save-hint'] !== undefined), undefined)
  save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  assert.deepEqual(view.calls.saved, [{
    name: 'Librarian',
    description: '',
    prompt: 'You keep the library.',
    defaultModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'low' },
  }])
})

test('card delete arms on the first click and calls deleteTemplate on the second', async () => {
  const deleted = []
  let listed = 0
  let list = [...CARD_TEMPLATES]
  const view = await mountSection({ roster: {
    listTemplates: async () => { listed += 1; return { ok: true, value: list } },
    deleteTemplate: async (id) => { deleted.push(id); list = list.filter((tpl) => tpl.id !== id); return { ok: true, value: { deleted: true } } },
  } })
  const button = () => find(view.vdom, (node) => node.props?.['data-agent-roster-row-delete'] === 'tpl-researcher')
  assert.ok(texts(button()).includes('t:card.delete'))
  // First click arms the confirmation only; nothing is deleted.
  await view.interact(() => { button().props.onClick() })
  assert.deepEqual(deleted, [])
  const armed = button()
  assert.ok(texts(armed).includes('t:card.delete.confirm'))
  // Second click deletes and refreshes the list.
  await view.interact(() => { armed.props.onClick() })
  assert.deepEqual(deleted, ['tpl-researcher'])
  assert.ok(listed >= 2, 'the list is re-read after deletion')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-row'] === 'tpl-researcher'), undefined)
})




test('card save and delete failures render bilingual error lines', async () => {
  // Save failure: the form stays open with the reason line.
  const view = await mountSection({ roster: {
    listTemplates: async () => ({ ok: true, value: CARD_TEMPLATES }),
    saveTemplate: async () => { throw Object.assign(new Error('Template name "X" is already taken / 名称已被占用'), { code: 'roster/name-taken' }) },
  } })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined).props.onClick()
  })
  await typeInto(view, 'data-agent-roster-role-name', 'Dup')
  await typeInto(view, 'data-agent-roster-role-prompt', 'P')
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined).props.onClick()
  })
  const error = find(view.vdom, (node) => node.props?.['data-agent-roster-card-form-error'] !== undefined)
  assert.ok(error, 'the save failure line renders')
  assert.equal(error.props['data-agent-roster-error'], 'roster/name-taken')
  const line = texts(error).join(' ')
  assert.ok(line.includes('t:card.saveFailed'))
  assert.ok(line.includes('roster/name-taken — Template name "X" is already taken / 名称已被占用'))
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined), 'the form stays open for a fix')
  // Delete failure: the list renders the reason line.
  const view2 = await mountSection({ roster: {
    listTemplates: async () => ({ ok: true, value: CARD_TEMPLATES }),
    deleteTemplate: async () => { throw Object.assign(new Error('store write failed / 存储写入失败'), { code: 'roster/store-write' }) },
  } })
  const del = () => find(view2.vdom, (node) => node.props?.['data-agent-roster-row-delete'] === 'tpl-researcher')
  await view2.interact(() => { del().props.onClick() })
  await view2.interact(() => { del().props.onClick() })
  const error2 = find(view2.vdom, (node) => node.props?.['data-agent-roster-card-error'] !== undefined)
  assert.ok(error2, 'the delete failure line renders')
  const line2 = texts(error2).join(' ')
  assert.ok(line2.includes('t:card.deleteFailed'))
  assert.ok(line2.includes('roster/store-write — store write failed / 存储写入失败'))
})

test('card list degrades: unavailable namespace, failed load, empty roster', async () => {
  const unavailable = await mountSection({ roster: null })
  assert.ok(texts(find(unavailable.vdom, (node) => node.props?.['data-agent-roster-note'] === 'unavailable')).join(' ')
    .includes('t:templates.unavailable'))
  const failed = await mountSection({ roster: {
    listTemplates: async () => { throw Object.assign(new Error('boom'), { code: 'roster/store-read' }) },
  } })
  const note = find(failed.vdom, (node) => node.props?.['data-agent-roster-note'] === 'error')
  assert.ok(texts(note).join(' ').includes('t:templates.error'))
  assert.ok(texts(note).join(' ').includes('roster/store-read — boom'))
  const empty = await mountSection({ roster: { listTemplates: async () => ({ ok: true, value: [] }) } })
  assert.ok(texts(find(empty.vdom, (node) => node.props?.['data-agent-roster-note'] === 'empty')).join(' ')
    .includes('t:templates.empty'))
})

test('card cancel returns to the list without writing anything', async () => {
  const view = await mountSection()
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined).props.onClick()
  })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-cancel'] !== undefined).props.onClick()
  })
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined), undefined)
  assert.ok(find(view.vdom, (node) => typeof node.props?.['data-agent-roster-row'] === 'string'), 'the list is back')
  assert.deepEqual(view.calls.saved, [])
  assert.deepEqual(view.calls.deleted, [])
})


// ---------------------------------------------------------------------------
// Review fix wave — the template defaultModel reaches the spawn flow, the
// template-load failure line, team-busy close gating, card banner hygiene.
// ---------------------------------------------------------------------------

/** A default-bearing template: the card's chip advertises its defaultModel. */
const SCOUT_TEMPLATE = {
  id: 'tpl-scout', name: 'Market Scout', description: 'Scans markets', prompt: 'You scan markets.',
  defaultModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
  createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-21T08:00:00.000Z',
}

/** Open the modal over the scout template (auto-selected first) plus a plain one. */
async function openScoutModal({ extras } = {}) {
  const spawned = []
  const view = await openModal({
    roster: {
      listTemplates: async () => ({ ok: true, value: [SCOUT_TEMPLATE, TEMPLATES[0]] }),
      spawnMember: async (input) => { spawned.push(input); return { ok: true, value: { name: 'spawned-member' } } },
      teamStatus: async () => ({ ok: true, value: HEALTHY_TEAM }),
    },
    extras,
  })
  view.scoutSpawned = spawned
  return view
}

test('a template defaultModel prefills the spawn selector and is sent (lossless without a catalog)', async () => {
  const reasonerKey = JSON.stringify(['deepseek', 'reasoner'])
  // With a catalog: the prefill maps to the catalog row; effort included.
  const view = await openScoutModal({ extras: { session: { modelCatalog: catalogFace } } })
  const select = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(select.props.value, reasonerKey, 'the selector prefills the template default')
  assert.equal(select.props['data-agent-roster-model'], reasonerKey)
  const effort = find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined)
  assert.equal(effort.props.value, 'high', 'the stored effort prefills too')
  let modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.deepEqual(view.scoutSpawned[0].model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
  // Without a catalog: the stored ref rides as a synthetic row and is still
  // sent whole (no silent null/clear of the template default).
  const view2 = await openScoutModal()
  const select2 = find(view2.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(select2.props.value, reasonerKey)
  modal = find(view2.vdom, (node) => node.type === Modal)
  await view2.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.deepEqual(view2.scoutSpawned[0].model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('an explicit spawn-selector choice overrides the template prefill; a new selection re-applies its own default', async () => {
  const chatKey = JSON.stringify(['deepseek', 'chat'])
  const view = await openScoutModal({ extras: { session: { modelCatalog: catalogFace } } })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
      .props.onChange({ target: { value: chatKey } })
  })
  let modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.deepEqual(view.scoutSpawned[0].model, { provider: 'deepseek', model: 'chat' }, 'the explicit choice wins')
  // Switching to the plain template re-applies ITS default (none): inherit.
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-template'] === 'tpl-researcher').props.onClick()
  })
  const select = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(select.props.value, '', 'the prefill follows the selection')
  assert.equal(select.props['data-agent-roster-model'], 'inherit')
  modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.equal(view.scoutSpawned[1].model, null)
})

test('reverting to inherit sends null — an explicit clear — and the default option says so', async () => {
  const view = await openScoutModal({ extras: { session: { modelCatalog: catalogFace } } })
  // Default-bearing template: the default entry's copy names the clear.
  const select = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.ok(texts(select.children[0]).join(' ').includes('t:model.inherit.clear'), 'the clear copy renders')
  await view.interact(() => { select.props.onChange({ target: { value: '' } }) })
  const modal = find(view.vdom, (node) => node.type === Modal)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  assert.equal(view.scoutSpawned[0].model, null, 'revert sends null (explicit clear, not the template fallback)')
  // A template WITHOUT a default keeps the plain inherit copy.
  const plain = await openModal()
  const plainSelect = find(plain.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  const label = texts(plainSelect.children[0]).join(' ')
  assert.ok(label.includes('t:model.inherit'))
  assert.equal(label.includes('t:model.inherit.clear'), false, 'no clear copy without a template default')
})

test('a not-ok listTemplates result renders the failure line, not the empty note', async () => {
  const view = await openModal({ roster: {
    listTemplates: async () => ({ ok: false, error: { code: 'roster/store-read', message: 'domain read failed / 域读取失败' } }),
    spawnMember: async () => ({ ok: true, value: { name: 'x' } }),
    teamStatus: async () => ({ ok: true, value: HEALTHY_TEAM }),
  } })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'error')
  assert.ok(note, 'the failure note renders')
  const line = texts(note).join(' ')
  assert.ok(line.includes('t:templates.error'))
  assert.ok(line.includes('roster/store-read — domain read failed / 域读取失败'))
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'empty'), undefined)
})

test('modal close is gated while a team action is in flight', async () => {
  let resolveEnable
  const view = await openModal({
    roster: rosterWithTeam({ teamMode: false, isRoot: true, canEnable: true }),
    extras: { agentTeams: { setEnabled: () => new Promise((resolve) => { resolveEnable = resolve }) } },
  })
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-team-enable'] !== undefined).props.onClick()
  })
  let modal = find(view.vdom, (node) => node.type === Modal)
  assert.equal(inModal(modal, (node) => node.props?.['data-agent-roster-cancel'] !== undefined).props.disabled, true)
  modal.props.onClose()
  await view.interact()
  assert.ok(find(view.vdom, (node) => node.type === Modal), 'the modal survives close while a team action runs')
  resolveEnable({ ok: true, value: undefined })
  await view.interact()
  modal = find(view.vdom, (node) => node.type === Modal)
  modal.props.onClose()
  await view.interact()
  assert.equal(find(view.vdom, (node) => node.type === Modal), undefined, 'close works again once the team action settles')
})


// ---------------------------------------------------------------------------
// Settings section — the AI-draft configuration block (2026-11-23 UX rework).
// ---------------------------------------------------------------------------

test('the settings block reads the form under the LOADER ROW id namespace', async () => {
  const view = await mountSection({ settings: { draftEnabled: true, draftModelProvider: 'deepseek', draftModelId: 'chat' } })
  // 'agent-roster' (the cordis.patch.yml row id), never the package name —
  // the wrong key left the block in Loading settings… forever. Ready means
  // the toggle renders checked instead of the loading note.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'loading'), undefined,
    'no loading note when the form resolves')
  const toggle = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-toggle'] !== undefined)
  assert.ok(toggle, 'the toggle renders (block is ready, not loading)')
  assert.equal(toggle.props.checked, true)
  assert.ok(view.recorded.configKeys.includes('agent-roster'), 'the row-id namespace is requested')
  assert.equal(view.recorded.configKeys.includes('dsh-agent-roster'), false, 'never the package name')
})

test('the AI-draft block stages the toggle and model through the config form', async () => {
  const view = await mountSection({
    extras: { session: { modelCatalog: catalogFace } },
    settings: { draftEnabled: false, draftModelProvider: '', draftModelId: '' },
  })
  const toggle = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-toggle'] !== undefined)
  assert.equal(toggle.props.checked, false)
  // Enable: one queued set of the volatile boolean.
  await view.interact(() => { toggle.props.onChange({ target: { checked: true } }) })
  assert.deepEqual(view.form.writes.sets, [['draftEnabled', true]])
  // Enabled without a model: the required-model hint renders.
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-draft-required'] !== undefined))
  // Pick a model from the catalog: one atomic mutation sets provider+model
  // and clears the effort.
  const model = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-model-setting'] !== undefined)
  await view.interact(() => { model.props.onChange({ target: { value: JSON.stringify(['deepseek', 'chat']) } }) })
  assert.deepEqual(view.form.writes.mutations, [[
    { op: 'set', path: ['draftModelProvider'], value: 'deepseek' },
    { op: 'set', path: ['draftModelId'], value: 'chat' },
    { op: 'set', path: ['draftReasoningEffort'], value: '' },
  ]])
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-draft-required'] !== undefined), undefined)
})

test('the AI-draft block reads back a configured model and offers its efforts', async () => {
  const view = await mountSection({
    extras: { session: { modelCatalog: catalogFace } },
    settings: { draftEnabled: true, draftModelProvider: 'deepseek', draftModelId: 'reasoner', draftReasoningEffort: 'high' },
  })
  const toggle = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-toggle'] !== undefined)
  assert.equal(toggle.props.checked, true)
  const model = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-model-setting'] !== undefined)
  assert.equal(model.props['data-agent-roster-draft-model-setting'], JSON.stringify(['deepseek', 'reasoner']))
  const effort = find(view.vdom, (node) => node.props?.['data-agent-roster-draft-effort-setting'] !== undefined)
  assert.ok(effort, 'the effort select renders for a model that advertises efforts')
  assert.equal(effort.props.value, 'high')
  await view.interact(() => { effort.props.onChange({ target: { value: 'low' } }) })
  assert.deepEqual(view.form.writes.sets, [['draftReasoningEffort', 'low']])
  // Unsetting the model clears all three fields atomically.
  await view.interact(() => { model.props.onChange({ target: { value: '' } }) })
  assert.deepEqual(view.form.writes.mutations.at(-1), [
    { op: 'set', path: ['draftModelProvider'], value: '' },
    { op: 'set', path: ['draftModelId'], value: '' },
    { op: 'set', path: ['draftReasoningEffort'], value: '' },
  ])
})

test('the add form points at the in-session drafting surface instead of embedding one', async () => {
  const view = await mountSection()
  await view.interact(() => {
    find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined).props.onClick()
  })
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined), 'the add form opens')
  assert.ok(texts(find(view.vdom, (node) => node.props?.['data-agent-roster-card-draft-hint'] !== undefined))
    .includes('t:draft.elsewhere'), 'the elsewhere hint renders')
  // No drafting controls exist on this surface at all.
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-draft'] !== undefined), undefined)
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-brief'] !== undefined), undefined)
})

test('card delete-failure banner clears on editor open and on a successful delete', async () => {
  let failFirst = true
  const deletedIds = []
  const view = await mountSection({ roster: {
    listTemplates: async () => ({ ok: true, value: CARD_TEMPLATES.filter((tpl) => !deletedIds.includes(tpl.id)) }),
    deleteTemplate: async (id) => {
      if (failFirst) {
        failFirst = false
        throw Object.assign(new Error('store write failed / 存储写入失败'), { code: 'roster/store-write' })
      }
      deletedIds.push(id)
      return { ok: true, value: { deleted: true } }
    },
  } })
  const del = () => find(view.vdom, (node) => node.props?.['data-agent-roster-row-delete'] === 'tpl-researcher')
  await view.interact(() => { del().props.onClick() })
  await view.interact(() => { del().props.onClick() })
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-card-error'] !== undefined), 'the failure banner renders')
  // Opening any editor clears the stale banner.
  await view.interact(() => { find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined).props.onClick() })
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-error'] !== undefined), undefined)
  await view.interact(() => { find(view.vdom, (node) => node.props?.['data-agent-roster-card-cancel'] !== undefined).props.onClick() })
  // A successful delete leaves no banner either, and the row is gone.
  await view.interact(() => { del().props.onClick() })
  await view.interact(() => { del().props.onClick() })
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-error'] !== undefined), undefined)
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-row'] === 'tpl-researcher'), undefined)
})
