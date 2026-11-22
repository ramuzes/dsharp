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
 */
function makeCtx({ roster } = {}) {
  const recorded = { commands: [], injects: [], registers: [], namespaces: [], mounts: [] }
  const remoteNamespaces = {}
  const services = {
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
        recorded.mounts.push(contribution)
        if (roster !== null && roster !== undefined) remoteNamespaces['remote.agentRoster'] = roster
        return Promise.resolve(() => {})
      },
    },
  }
  const ctx = new Proxy({
    effect(fn) { return fn() ?? undefined },
    get(name) { return remoteNamespaces[name] },
  }, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop]
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      if (Object.prototype.hasOwnProperty.call(services, prop)) return services[prop]
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
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

/** Boot the browser plugin against a fresh harness. */
function bootPlugin() {
  const harness = createHarness({ leaves: [Modal, IconPlusOutlineRegular] })
  const require = (specifier) => {
    if (specifier === 'react') return harness.React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives()
    throw new Error(`unexpected require: ${specifier}`)
  }
  return { harness, plugin: loaded[0].factory(require) }
}

/** Apply the plugin against a strict ctx and return the harness, the recordings, and the style node. */
function applyPlugin({ roster } = {}) {
  const { harness, plugin } = bootPlugin()
  const [ctx, recorded] = makeCtx({ roster })
  const style = { dataset: {}, textContent: '', remove() {} }
  withDocument(
    { createElement: () => style, head: { append() {} } },
    () => plugin.apply(ctx),
  )
  return { harness, recorded, style }
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
 * recorded spawn calls. `roster: null` leaves the remote namespace absent.
 */
async function openModal({ roster } = {}) {
  const spawned = []
  const rosterFake = roster === undefined
    ? {
      listTemplates: async () => ({ ok: true, value: TEMPLATES }),
      spawnMember: async (input) => { spawned.push(input); return { ok: true, value: { name: 'spawned-member' } } },
    }
    : roster
  const { harness, recorded } = applyPlugin({ roster: rosterFake })
  const seat = recorded.registers.find(({ declaration }) => declaration.name === 'conversation.input.overlay')
  assert.ok(seat, 'the overlay seat is registered')
  const props = { t: makeT(), ...seat.declaration.inject('sess-1') }
  const view = { vdom: undefined, spawned, harness }
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
  assert.deepEqual(plugin.inject, ['commandUi', 'locale', 'slots', 'remote'])
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
  const inputParameter = [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'src-json' } }]
  assert.deepEqual(byMethod.get('listTemplates').parameters, [])
  assert.deepEqual(byMethod.get('saveTemplate').parameters, inputParameter)
  assert.deepEqual(byMethod.get('deleteTemplate').parameters,
    [{ name: 'id', wire: 'id', source: 'json', codec: { mode: 'src-json' } }])
  assert.deepEqual(byMethod.get('spawnMember').parameters, inputParameter)
  assert.deepEqual(byMethod.get('teamStatus').parameters, inputParameter)
  assert.deepEqual(byMethod.get('draft').parameters, inputParameter)
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
  // The model selector is the inherit-only stub this task ships.
  const modelSelect = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.equal(modelSelect.type, 'select')
  assert.equal(modelSelect.props.disabled, true)
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
