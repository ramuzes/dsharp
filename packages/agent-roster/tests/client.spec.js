/**
 * Client-half specs (ADR-0011 shape): the "+" modal composes one instruction
 * from a role template and injects it into the current session through the
 * composer-equivalent path; the Settings section manages templates; the plugin
 * itself spawns nothing.
 *
 * Harness notes: real React + react-test-renderer (per-fiber hook state for the
 * conditional dropdowns — the hand-written fake could not model it), fakes that
 * mirror real strictness (the Remote mount enforces strict codecs; the ctx
 * double throws on non-injected access), no DOM (so portaled menus render
 * inline and `document` is absent except where a test installs a double).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// Real React + the DOM-less test renderer: the plugin's hook-heavy nested
// tree (conditional ModelMenus, effects, portals) exceeded what a hand
// fake could model faithfully — real fiber semantics end that class of bug.
import ReactReal from 'react'
import TestRenderer, { act } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Everything the factory's module-loader call hands back. */
const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load: (module) => { loaded.push(module) },
  },
}

// Import LAST: the module calls window.__ModuleLoader__.load at evaluation.
await import('../client.js')

/** Stand-in for the shared Modal primitive (ui-primitives index.ts:51):
 * a host div carrying the chrome props tests assert on (title, closeLabel,
 * onClose) plus the children — the real Modal portals to body, which no DOM
 * exists here to receive. */
function Modal(props) {
  return ReactReal.createElement('div', {
    'data-fake-modal': props?.open === false ? 'closed' : 'open',
    title: props?.title,
    'aria-label': props?.title,
    onClick: props?.onClose,
    onClose: props?.onClose,
    closeLabel: props?.closeLabel,
  }, props?.children, props?.footer)
}

/** Stand-ins for the shared icons (icons/index.tsx): no visual output. */
function IconPlusOutlineRegular(props) { return null }
function IconChevronDownOutlineRegular() { return null }
function IconCheckOutlineRegular() { return null }

/** Menu primitives (real exports: ui-primitives index.ts:38-40) as host
 * divs; the group keeps its label as data for assertions. */
function MenuSurface(props) {
  return ReactReal.createElement('div', { 'data-agent-roster-fake': 'surface', role: props?.role }, props?.children)
}
function MenuGroup(props) {
  return ReactReal.createElement('div', { 'data-agent-roster-fake-group': String(props?.label ?? '') }, props?.children)
}

/** The primitives module the factory's require hands out: the real export names we consume. */
/**
 * SegmentedControl stand-in mirroring the REAL contract
 * (ui-primitives src/SegmentedControl.tsx): a labelled tablist of role=tab
 * buttons, fully controlled, `onChange(next)` only for a value that differs
 * from the current one, every segment disabled under `disabled`.
 */
function SegmentedControl(props) {
  const { id, value, options, onChange, label, disabled = false } = props ?? {}
  return ReactReal.createElement('div', { role: 'tablist', 'aria-label': label },
    (options ?? []).map((option) => ReactReal.createElement('button', {
      key: option.value,
      id: `${id}-${option.value}`,
      type: 'button',
      role: 'tab',
      'aria-selected': option.value === value,
      disabled: disabled || option.disabled === true,
      onClick: () => { if (option.value !== value) onChange(option.value) },
    }, option.label)))
}

function primitives() {
  return { Modal, IconPlusOutlineRegular, MenuSurface, MenuGroup, IconChevronDownOutlineRegular, IconCheckOutlineRegular, SegmentedControl }
}

/**
 * The render harness over react-test-renderer (real React fiber semantics:
 * per-component hook state, conditional mounting, effects under act) with
 * the SAME outer API the suite was written against: render/rerender/flush/
 * settle plus the vdom shape {type, props, children} that find/findAll/
 * texts traverse. Interactions run inside act so state updates and effects
 * settle deterministically.
 */
function createHarness() {
  let root = undefined
  let last = undefined
  const render = (component, props) => {
    last = { component, props }
    const element = ReactReal.createElement(component, props)
    act(() => {
      if (root === undefined) root = TestRenderer.create(element)
      else root.update(element)
    })
    return root.toJSON()
  }
  return {
    React: ReactReal,
    render,
    rerender() { return last === undefined ? undefined : render(last.component, last.props) },
    flush() {},
    async settle(rounds = 6) {
      for (let round = 0; round < rounds; round += 1) {
        await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
        this.rerender()
      }
    },
  }
}

/** All string children under a node, including prop-borne trees (Modal footer). */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (typeof node !== 'object') return out
  for (const value of Object.values(node.props ?? {})) {
    if (typeof value === 'string' || Array.isArray(value) || (typeof value === 'object' && value !== null && value.type !== undefined)) {
      texts(value, out)
    }
  }
  texts(node.children, out)
  return out
}

/** Depth-first find of the first node matching predicate. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  const nested = find(node.children, predicate)
  if (nested !== undefined) return nested
  for (const value of Object.values(node.props ?? {})) {
    if (value !== null && typeof value === 'object') {
      const hit = find(value, predicate)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** Depth-first collect of every node matching predicate. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  for (const value of Object.values(node.props ?? {})) {
    if (value !== null && typeof value === 'object') findAll(value, predicate, out)
  }
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
 * — `t:key(k=v,…)` — so tests can prove a value reached the interpolating call.
 */
function makeT() {
  return (key, params = {}) => {
    const pairs = Object.entries(params)
    return pairs.length === 0 ? `t:${key}` : `t:${key}(${pairs.map(([k, v]) => `${k}=${v}`).join(',')})`
  }
}

/** Every leaf key of a locale object. */
function keys(value, prefix = '') {
  const out = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object') out.push(...keys(child, path))
    else out.push(path)
  }
  return out
}

/**
 * The fake ctx: inject-list strictness (unknown property access throws, the
 * AGENTS.md rule), a `$mount` that mirrors the REAL gateway validation, and a
 * `sessions` fake recording the composer-equivalent injection.
 */
function makeCtx({ roster, extras, sessions: sessionsConfig } = {}) {
  const recorded = { commands: [], injects: [], registers: [], namespaces: [], mounts: [] }
  const remoteNamespaces = {}
  for (const [name, face] of Object.entries(extras ?? {})) remoteNamespaces[`remote.${name}`] = face
  // The sessions fake mirrors the real contract (api/session-controller
  // src/client/sessions/session.ts): using(target, options, operation) hands
  // back a reference whose binding.session.command(line) admits one
  // slash-command line and answers { ok, value: { matched } } — the outcome
  // itself is rendered by the host as a flow node, never echoed to the caller.
  const sessionCalls = []
  const sessions = {
    calls: sessionCalls,
    fail: sessionsConfig?.fail ?? null,
    commandResult: sessionsConfig?.commandResult ?? { ok: true, value: { matched: true } },
    using: async (target, options, operation) => {
      sessionCalls.push({ target, options })
      if (sessions.fail !== null) throw sessions.fail
      return operation({
        binding: {
          session: {
            command: async (line) => {
              sessionCalls.push({ command: line })
              return sessions.commandResult
            },
          },
        },
      })
    },
  }
  const services = {
    commandUi: { register: (contribution) => { recorded.commands.push(contribution); return () => {} } },
    locale: {
      bind: () => makeT(),
      register: (ns, dicts) => { recorded.namespaces.push({ ns, dicts }) },
    },
    sessions,
    slots: {
      inject: (name, begin) => { recorded.injects.push(name); return begin() },
      register: (declaration, Component) => { recorded.registers.push({ declaration, Component }); return () => {} },
    },
    remote: {
      $mount: (contribution) => {
        // Mirror the REAL gateway validation, not a more forgiving one
        // (AGENTS.md §1): dsh packages/api/gateway/src/client/index.ts
        // validateContribution (:283-330) — requireStrictInputs rejects any
        // parameter whose codec mode is not 'strict', and duplicate
        // (namespace, method) pairs reject.
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
    get(name) { return remoteNamespaces[name] ?? services[name] },
  }, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop]
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      if (Object.prototype.hasOwnProperty.call(services, prop)) return services[prop]
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
  return [ctx, recorded, sessions]
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
  const harness = createHarness()
  const require = (specifier) => {
    if (specifier === 'react') return harness.React
    if (specifier === 'react-dom') {
      // No document exists here, so client.js takes its inline-menu branch
      // and never calls createPortal; the binding only satisfies the
      // factory's destructure.
      return { createPortal: () => { throw new Error('createPortal without a DOM') } }
    }
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

/** Apply the plugin against a strict ctx and return the harness, recordings, and style node. */
function applyPlugin({ roster, extras, sessions } = {}) {
  const { harness, plugin } = bootPlugin()
  const [ctx, recorded, sessionsFake] = makeCtx({ roster, extras, sessions })
  const style = { dataset: {}, textContent: '', remove() {} }
  withDocument(
    { createElement: () => style, head: { append() {} } },
    () => plugin.apply(ctx),
  )
  return { harness, recorded, style, sessions: sessionsFake }
}

/** Two templates the fake roster serves. */
const TEMPLATES = [
  { id: 'tpl-researcher', name: 'Researcher', description: 'Finds and reads sources', prompt: 'You research topics thoroughly.', defaultModel: null, createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-20T08:00:00.000Z' },
  { id: 'tpl-reviewer', name: 'Reviewer', description: 'Reviews code diffs', prompt: 'You review diffs critically.', defaultModel: null, createdAt: '2026-11-21T08:00:00.000Z', updatedAt: '2026-11-21T08:00:00.000Z' },
]

/** The healthy roster face: CRUD plus the high-tier use log — the plugin's whole remote surface. */
function healthyRoster(overrides = {}) {
  const saved = []
  const deleted = []
  const staged = []
  const face = {
    saved,
    deleted,
    staged,
    listTemplates: async () => ({ ok: true, value: TEMPLATES }),
    stageSpawn: async (input) => { staged.push(input); return { ok: true, value: { staged: true } } },
    saveTemplate: async (input) => {
      saved.push(input)
      return { ok: true, value: { ...TEMPLATES[0], ...input, id: input.id ?? 'tpl-new' } }
    },
    deleteTemplate: async (id) => { deleted.push(id); return { ok: true, value: { deleted: true } } },
    listHighTierUse: async () => ({ ok: true, value: [] }),
    ...overrides,
  }
  return face
}

/**
 * Boot, apply, mount the overlay seat, and open the modal through the
 * registered command's run(session) — the exact production path.
 * `roster: null` leaves the remote namespace absent.
 */
async function openModal({ roster, extras, sessions } = {}) {
  const rosterFake = roster === undefined ? healthyRoster() : roster
  const { harness, recorded, sessions: sessionsFake } = applyPlugin({ roster: rosterFake, extras, sessions })
  const seat = recorded.registers.find(({ declaration }) => declaration.name === 'conversation.input.overlay')
  assert.ok(seat, 'the overlay seat is registered')
  const props = { t: makeT(), ...seat.declaration.inject('sess-1') }
  const view = { vdom: undefined, harness, sessions: sessionsFake, roster: rosterFake }
  const render = () => { view.vdom = harness.render(seat.Component, props) }
  render()
  await harness.settle()
  render()
  view.interact = async (gesture) => {
    if (gesture !== undefined) gesture()
    await harness.settle()
    render()
  }
  recorded.commands[0].ui.run({ sessionId: 'sess-1' })
  await view.interact()
  return view
}

/** Render just the Settings section (its own registration seat). */
async function mountSection({ roster, extras } = {}) {
  const rosterFake = roster === undefined ? healthyRoster() : roster
  const { harness, recorded } = applyPlugin({ roster: rosterFake, extras })
  const entry = recorded.registers.find(({ declaration }) => declaration.name === 'settings.section')
  assert.ok(entry, 'the settings.section entry is registered')
  const view = { vdom: undefined, harness, roster: rosterFake }
  const props = { id: 'agent-roster', close: () => {}, t: makeT(), ...entry.declaration.inject?.('agent-roster') }
  const render = () => { view.vdom = harness.render(entry.Component, props) }
  render()
  await harness.settle()
  render()
  view.interact = async (gesture) => {
    if (gesture !== undefined) gesture()
    await harness.settle()
    render()
  }
  return view
}

/** Open one ModelMenu (click its trigger) and pick one option row. */
async function pickMenuOption(view, triggerMarker, optionKey) {
  const trigger = find(view.vdom, (node) => node.props?.[triggerMarker] !== undefined
    && node.props?.['data-agent-roster-menu-value'] !== undefined)
  assert.ok(trigger, `the ${triggerMarker} trigger renders`)
  await view.interact(() => { trigger.props.onClick() })
  const option = find(view.vdom, (node) => node.props?.['data-agent-roster-menu-option'] === optionKey)
  assert.ok(option, `menu option ${optionKey} renders while open`)
  await view.interact(() => { option.props.onClick() })
}

/** Type into one field marked with a data-agent-roster-* attribute. */
async function typeInto(view, marker, value) {
  const field = find(view.vdom, (node) => typeof node.props?.[marker] === 'string')
  assert.ok(field, `the ${marker} field renders`)
  await view.interact(() => { field.props.onChange({ target: { value } }) })
}

/** The model catalog face (remote.session.modelCatalog shape). */
const CATALOG = {
  groups: [
    { id: 'deepseek', name: 'DeepSeek', models: [
      { id: 'chat', name: 'DeepSeek Chat' },
      { id: 'reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
    ] },
  ],
}
const catalogFace = () => ({ ok: true, value: CATALOG })

// ---------------------------------------------------------------------------
// Module shape, locale, mount
// ---------------------------------------------------------------------------

test('client.js registers one module named dsh-agent-roster in the factory format', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-agent-roster')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('the factory returns a plugin injecting the documented services only', () => {
  const { plugin } = bootPlugin()
  assert.deepEqual(plugin.inject, ['commandUi', 'locale', 'sessions', 'slots', 'remote'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the command, the overlay seat, dictionaries, and scoped styles', () => {
  const { recorded, style } = applyPlugin({})
  assert.equal(recorded.commands.length, 1)
  assert.equal(recorded.commands[0].name, 'add-agent-member')
  assert.equal(recorded.namespaces.length, 1)
  assert.deepEqual(Object.keys(recorded.namespaces[0].dicts).sort(), ['en', 'zh'])
  assert.equal(recorded.injects.includes('conversation.input.overlay'), true)
  assert.equal(recorded.injects.includes('settings.section'), true)
  assert.match(style.textContent, /\[data-agent-roster\]/)
})

test('locale dictionaries have zh/en key parity and interpolate {param}', () => {
  const { recorded } = applyPlugin({})
  const { zh, en } = recorded.namespaces[0].dicts
  assert.deepEqual(keys(zh).sort(), keys(en).sort())
  const t = makeT()
  assert.equal(t('command.sent', { name: 'Reviewer' }), 't:command.sent(name=Reviewer)')
})

test('the remote namespace mounts five method descriptors', () => {
  const { recorded } = applyPlugin({})
  assert.equal(recorded.mounts.length, 1)
  const mount = recorded.mounts[0]
  assert.equal(mount.package, 'dsh-agent-roster')
  assert.deepEqual(mount.descriptors.map((d) => d.method).sort(), ['deleteTemplate', 'listHighTierUse', 'listTemplates', 'saveTemplate', 'stageSpawn'])
})

// ---------------------------------------------------------------------------
// The "+" modal — staging the member request and running /roster
// ---------------------------------------------------------------------------

test('run(session) opens the modal through the overlay seat and cancel closes it', async () => {
  const view = await openModal()
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  assert.ok(modal, 'the modal is open')
  assert.equal(modal.props['data-fake-modal'], 'open')
  assert.equal(modal.props.title, 't:modal.title')
  assert.equal(modal.props.closeLabel, 't:modal.close')
  const root = find(view.vdom, (node) => node.props?.['data-agent-roster'] !== undefined)
  assert.ok(root, 'the scoped root renders')
  // Templates, the per-spawn model, the first task. There is no instruction
  // preview any more: the dialog injects nothing into the conversation
  // (ADR-0012) — it stages a request and runs /roster.
  assert.deepEqual(root.children.map((child) => child.props['data-agent-roster-section']),
    ['templates', 'model', 'task'])
  const cancel = inModal(modal, (node) => node.props?.['data-agent-roster-cancel'] !== undefined)
  await view.interact(() => { cancel.props.onClick() })
  assert.equal(find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node), undefined)
})

/** Templates carrying default models, so an override has something to beat. */
const ROUTED_RESEARCHER = { ...TEMPLATES[0], defaultModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } }
const ROUTED_SCOUT = { ...TEMPLATES[1], name: 'Scout', defaultModel: { provider: 'acme', model: 'scout-1' } }
const withCatalog = { session: { modelCatalog: catalogFace } }
const serving = (...templates) => healthyRoster({ listTemplates: async () => ({ ok: true, value: templates }) })
const REASONER = JSON.stringify(['deepseek', 'reasoner'])
const CHAT = JSON.stringify(['deepseek', 'chat'])

/** The member-model picker trigger (asserted present so a missing picker fails as an assertion, not a TypeError). */
function modelTrigger(view) {
  const trigger = find(view.vdom, (node) => node.props?.['data-agent-roster-model'] !== undefined)
  assert.ok(trigger, 'the member-model picker renders')
  return trigger
}
function effortTrigger(view) {
  const trigger = find(view.vdom, (node) => node.props?.['data-agent-roster-effort'] !== undefined)
  assert.ok(trigger, 'the reasoning-effort picker renders')
  return trigger
}
const effortAreaOn = (view) => find(view.vdom, (node) => node.props?.['data-agent-roster-effort-area'] === 'on')

async function confirmModal(view) {
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
}
/** Confirm and return the one request the dialog staged. */
async function stagedRequest(view) {
  await confirmModal(view)
  assert.equal(view.roster.staged.length, 1, 'exactly one request was staged')
  return view.roster.staged[0]
}
/** The command lines the dialog ran against the session. */
const commandLines = (view) => view.sessions.calls.filter((call) => call.command !== undefined).map((call) => call.command)
const errorBanner = (view) => find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'error')
/** The template dropdown trigger (asserted present so a missing picker fails as an assertion). */
function templateTrigger(view) {
  const trigger = find(view.vdom, (node) => node.props?.['data-agent-roster-template'] !== undefined)
  assert.ok(trigger, 'the template dropdown trigger renders')
  return trigger
}

test('the template picker is a dropdown whose trigger names the selected template', async () => {
  const view = await openModal()
  // No flat list of template buttons any more: one host-style dropdown, so a
  // large roster never overflows the dialog (user request, 2026-11-25).
  assert.equal(find(view.vdom, (node) => node.props?.role === 'listbox'), undefined)
  assert.equal(templateTrigger(view).props['data-agent-roster-menu-value'], 'tpl-researcher')
  assert.ok(texts(templateTrigger(view)).includes('Researcher'))
})

test('opening the template dropdown lists every template by name, the current one checked, with no empty option', async () => {
  const view = await openModal()
  await view.interact(() => { templateTrigger(view).props.onClick() })
  const options = findAll(view.vdom, (node) => node.props?.['data-agent-roster-menu-option'] !== undefined)
  assert.deepEqual(options.map((option) => option.props['data-agent-roster-menu-option']),
    ['tpl-researcher', 'tpl-reviewer'], 'every template and no "none" row: a template is always selected')
  assert.deepEqual(options.map((option) => option.props['aria-checked']), ['true', 'false'])
  assert.ok(texts(options[1]).includes('Reviewer'))
  assert.equal(texts(options[1]).includes('Reviews code diffs'), false, 'rows carry names only')
})

test('the selected template description shows under the trigger when it has one', async () => {
  const view = await openModal()
  const hint = find(view.vdom, (node) => node.props?.['data-agent-roster-template-desc'] !== undefined)
  assert.ok(hint, 'the description line renders for a template with a description')
  assert.ok(texts(hint).includes('Finds and reads sources'))
})

test('confirm stages the request for this session and runs /roster — nothing is injected into the conversation', async () => {
  const view = await openModal()
  const request = await stagedRequest(view)
  // An untouched template without a default: inherit the session model, no task.
  assert.deepEqual(request, { sessionId: 'sess-1', templateId: 'tpl-researcher', model: null, task: '' })
  assert.deepEqual(view.sessions.calls, [
    { target: 'sess-1', options: { source: 'agent-roster' } },
    // Bare on purpose: a lost staged request must surface as the usage text,
    // never fall back to adding a member with the template defaults.
    { command: '/roster' },
  ], 'the session receives one bare command line and never a prompt')
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'success')
  assert.ok(banner, 'the success banner renders')
  assert.ok(texts(banner).includes('t:command.sent(name=Researcher)'))
})

test('picking another template stages that template; the command line stays bare', async () => {
  const view = await openModal()
  await pickMenuOption(view, 'data-agent-roster-template', 'tpl-reviewer')
  const request = await stagedRequest(view)
  assert.equal(request.templateId, 'tpl-reviewer')
  assert.deepEqual(commandLines(view), ['/roster'])
})

test('the task field travels to the staging as typed; the host trims it', async () => {
  const view = await openModal()
  await typeInto(view, 'data-agent-roster-task', '  review the payments module  ')
  // The dialog forwards the field verbatim; AgentRosterService.stageSpawn
  // trims (tests/host.spec.js "task trimmed"), so there is one trimming rule.
  assert.equal((await stagedRequest(view)).task, '  review the payments module  ')
})

test('the member model starts from the template default, effort included', async () => {
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER), extras: withCatalog })
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], REASONER)
  assert.equal(effortTrigger(view).props['data-agent-roster-menu-value'], 'high')
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('picking another model overrides the template default and drops the template effort', async () => {
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER), extras: withCatalog })
  await pickMenuOption(view, 'data-agent-roster-model', CHAT)
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], CHAT)
  // chat advertises no efforts: the control is hidden and the template's `high`
  // must not leak into the new route.
  assert.equal(effortAreaOn(view), undefined)
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'chat' })
})

test('choosing inherit stages model null even when the template has a default', async () => {
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER), extras: withCatalog })
  await pickMenuOption(view, 'data-agent-roster-model', '')
  // Inherit state: the raw value is '' and the marker attribute says 'inherit'.
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], '')
  assert.equal(modelTrigger(view).props['data-agent-roster-model'], 'inherit')
  assert.equal((await stagedRequest(view)).model, null)
})

test('switching templates resets the member model to the new template default', async () => {
  // No catalog face here: the picker still names each default through its
  // lossless synthetic row, so a missing catalog never blocks the choice.
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER, ROUTED_SCOUT) })
  await pickMenuOption(view, 'data-agent-roster-template', 'tpl-reviewer')
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], JSON.stringify(['acme', 'scout-1']))
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'acme', model: 'scout-1' })
})

test('an explicit reasoning model offers its efforts and the chosen effort is staged', async () => {
  const view = await openModal({ extras: withCatalog })
  assert.equal(modelTrigger(view).props['data-agent-roster-model'], 'inherit')
  assert.equal(effortAreaOn(view), undefined)
  await pickMenuOption(view, 'data-agent-roster-model', REASONER)
  assert.ok(effortAreaOn(view), 'the effort picker appears for a reasoning model')
  await pickMenuOption(view, 'data-agent-roster-effort', 'high')
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('re-picking the template default model restores its stored effort', async () => {
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER), extras: withCatalog })
  await pickMenuOption(view, 'data-agent-roster-model', CHAT)
  await pickMenuOption(view, 'data-agent-roster-model', REASONER)
  assert.equal(effortTrigger(view).props['data-agent-roster-menu-value'], 'high')
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('changing only the effort keeps the template model', async () => {
  // The pick must capture the model that is in effect, not turn the spawn into
  // "inherit": the user asked for another effort, not for another model.
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER), extras: withCatalog })
  await pickMenuOption(view, 'data-agent-roster-effort', 'low')
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], REASONER)
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'low' })
})

test('a stored default with an empty provider or model is treated as no default', async () => {
  const broken = { ...TEMPLATES[0], defaultModel: { provider: 'acme', model: '' } }
  const view = await openModal({ roster: serving(broken), extras: withCatalog })
  assert.equal(modelTrigger(view).props['data-agent-roster-model'], 'inherit')
  assert.equal((await stagedRequest(view)).model, null)
})

test('a stored effort the catalog no longer advertises stays selectable and is staged', async () => {
  // chat advertises no efforts; a stored `high` must not be shown as "model
  // default" while still being sent.
  const stale = { ...TEMPLATES[0], defaultModel: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } }
  const view = await openModal({ roster: serving(stale), extras: withCatalog })
  assert.ok(effortAreaOn(view), 'the stored effort is offered')
  assert.equal(effortTrigger(view).props['data-agent-roster-menu-value'], 'high')
  assert.ok(texts(effortTrigger(view)).includes('high'))
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
})

test('an override is remembered per template while the dialog stays open', async () => {
  // Deliberate (SPEC): switching templates shows the NEW template's default;
  // switching back restores the pick made for that template.
  const view = await openModal({ roster: serving(ROUTED_RESEARCHER, ROUTED_SCOUT), extras: withCatalog })
  await pickMenuOption(view, 'data-agent-roster-model', CHAT)
  const scout = 'tpl-reviewer'
  const back = 'tpl-researcher'
  await pickMenuOption(view, 'data-agent-roster-template', scout)
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], JSON.stringify(['acme', 'scout-1']))
  await pickMenuOption(view, 'data-agent-roster-template', back)
  assert.equal(modelTrigger(view).props['data-agent-roster-menu-value'], CHAT)
  assert.deepEqual((await stagedRequest(view)).model, { provider: 'deepseek', model: 'chat' })
})

test('a refused staging renders its error and runs no command', async () => {
  const view = await openModal({
    roster: healthyRoster({ stageSpawn: async () => ({ ok: false, error: { code: 'roster/not-found', message: 'Template gone' } }) }),
  })
  await confirmModal(view)
  const banner = errorBanner(view)
  assert.ok(banner, 'the error banner renders')
  assert.equal(banner.props['data-agent-roster-error'], 'roster/not-found')
  assert.ok(texts(banner).some((line) => line.includes('Template gone')))
  assert.deepEqual(commandLines(view), [], 'no command runs on a refused request')
  assert.ok(find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node), 'still open')
})

test('a command the host does not know is reported, not silently ignored', async () => {
  // matched:false means no /roster is registered on this host (the host half
  // missing or too old).
  const view = await openModal({ sessions: { commandResult: { ok: true, value: { matched: false } } } })
  await confirmModal(view)
  const banner = errorBanner(view)
  assert.ok(banner, 'the error banner renders')
  assert.ok(texts(banner).some((line) => line.includes('t:command.unmatched')))
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'success'), undefined)
})

test('a refused command admission renders its error with the upstream code', async () => {
  const view = await openModal({
    sessions: { commandResult: { ok: false, error: { code: 'session/agent-busy', message: 'agent busy' } } },
  })
  await confirmModal(view)
  const banner = errorBanner(view)
  assert.ok(banner, 'the error banner renders')
  assert.equal(banner.props['data-agent-roster-error'], 'session/agent-busy')
  assert.ok(texts(banner).some((line) => line.includes('agent busy')))
})

test('a missing roster namespace degrades to the unavailable line, never a crash', async () => {
  const view = await openModal({ roster: null })
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'unavailable'))
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  const confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  assert.equal(confirm.props.disabled, true, 'nothing to inject without a template')
})

test('a failed template load renders the error line with the upstream message', async () => {
  const view = await openModal({
    roster: healthyRoster({ listTemplates: async () => ({ ok: false, error: { code: 'roster/storage-degraded', message: 'storage closed' } }) }),
  })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'error')
  assert.ok(note, 'the failure note renders')
  assert.equal(note.props['data-agent-roster-error'], 'roster/storage-degraded')
  assert.ok(texts(note).some((line) => line.includes('storage closed')))
})

test('an empty roster points at the Settings page instead of offering a dead confirm', async () => {
  const view = await openModal({ roster: healthyRoster({ listTemplates: async () => ({ ok: true, value: [] }) }) })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'empty')
  assert.ok(note, 'the empty note renders')
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  assert.equal(inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.disabled, true)
})

// ---------------------------------------------------------------------------
// Settings section — the roster manager
// ---------------------------------------------------------------------------

test('the roster manager registers one settings.section entry under the loader row id', () => {
  const { recorded } = applyPlugin({})
  const entry = recorded.registers.find(({ declaration }) => declaration.name === 'settings.section')
  assert.ok(entry, 'one settings.section entry')
  assert.equal(entry.declaration.id, 'agent-roster')
  assert.equal(entry.declaration.order, 40)
})

test('the card lists records with the model chip and the updated time', async () => {
  const view = await mountSection()
  const ids = findAll(view.vdom, (node) => typeof node.props?.['data-agent-roster-row'] === 'string')
  assert.deepEqual(ids.map((node) => node.props['data-agent-roster-row']), ['tpl-researcher', 'tpl-reviewer'])
  const chips = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-model'] !== undefined)
  assert.equal(chips.length, 2)
  assert.ok(texts(chips[0]).includes('t:card.model.none'))
  assert.ok(texts(view.vdom).some((line) => line.startsWith('t:card.updatedAt(time=')))
})

test('the add form gates on name+prompt, defaults to no model, and sends no id', async () => {
  const view = await mountSection()
  const add = find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined)
  await view.interact(() => { add.props.onClick() })
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined))
  const save = () => find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  assert.equal(save().props.disabled, true, 'gated while incomplete')
  await typeInto(view, 'data-agent-roster-role-name', 'Market Scout')
  assert.equal(save().props.disabled, true, 'still gated without a prompt')
  await typeInto(view, 'data-agent-roster-role-prompt', 'You scout markets.')
  assert.equal(save().props.disabled, false)
  await view.interact(() => { save().props.onClick() })
  assert.equal(view.roster.saved.length, 1)
  assert.equal(view.roster.saved[0].id, undefined, 'add sends no id')
  assert.equal(view.roster.saved[0].name, 'Market Scout')
  assert.equal(view.roster.saved[0].defaultModel, null)
})

test('edit prefills the shared fields and saves through saveTemplate with the id', async () => {
  const view = await mountSection()
  const edit = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-edit'] !== undefined)[1]
  await view.interact(() => { edit.props.onClick() })
  const name = find(view.vdom, (node) => typeof node.props?.['data-agent-roster-role-name'] === 'string')
  assert.equal(name.props.value, 'Reviewer')
  await typeInto(view, 'data-agent-roster-role-prompt', 'You review diffs mercilessly.')
  const save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  assert.equal(view.roster.saved.length, 1)
  assert.equal(view.roster.saved[0].id, 'tpl-reviewer')
  assert.equal(view.roster.saved[0].prompt, 'You review diffs mercilessly.')
})

test('the default-model picker offers the catalog through the host dropdown and sends a ModelRef', async () => {
  const view = await mountSection({ extras: { session: { modelCatalog: catalogFace } } })
  const add = find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined)
  await view.interact(() => { add.props.onClick() })
  await typeInto(view, 'data-agent-roster-role-name', 'Market Scout')
  await typeInto(view, 'data-agent-roster-role-prompt', 'You scout markets.')
  await pickMenuOption(view, 'data-agent-roster-card-model', JSON.stringify(['deepseek', 'reasoner']))
  const save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  assert.deepEqual(view.roster.saved[0].defaultModel, { provider: 'deepseek', model: 'reasoner' })
})

test('a template defaultModel prefills the editor losslessly even without a catalog', async () => {
  const view = await mountSection({
    roster: healthyRoster({ listTemplates: async () => ({ ok: true, value: [{ ...TEMPLATES[0], defaultModel: { provider: 'acme', model: 'custom-1' } }] }) }),
  })
  const edit = find(view.vdom, (node) => node.props?.['data-agent-roster-row-edit'] !== undefined)
  await view.interact(() => { edit.props.onClick() })
  const trigger = find(view.vdom, (node) => node.props?.['data-agent-roster-card-model'] !== undefined)
  assert.equal(trigger.props['data-agent-roster-menu-value'], JSON.stringify(['acme', 'custom-1']))
  assert.ok(texts(trigger).includes('acme / custom-1'))
})

test('delete arms on the first click and calls deleteTemplate on the second', async () => {
  const view = await mountSection()
  const del = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-delete'] !== undefined)[1]
  await view.interact(() => { del.props.onClick() })
  assert.deepEqual(view.roster.deleted, [], 'first click only arms')
  assert.ok(texts(view.vdom).some((line) => line.includes('t:card.delete.confirm')))
  const armed = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-delete'] !== undefined)[1]
  await view.interact(() => { armed.props.onClick() })
  assert.deepEqual(view.roster.deleted, ['tpl-reviewer'])
})

test('card save and delete failures render bilingual error lines', async () => {
  const view = await mountSection({
    roster: healthyRoster({
      saveTemplate: async () => ({ ok: false, error: { code: 'roster/name-taken', message: 'name taken' } }),
      deleteTemplate: async () => ({ ok: false, error: { code: 'roster/not-found', message: 'gone' } }),
    }),
  })
  const edit = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-edit'] !== undefined)[0]
  await view.interact(() => { edit.props.onClick() })
  const save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  const saveError = find(view.vdom, (node) => node.props?.['data-agent-roster-error'] === 'roster/name-taken')
  assert.ok(saveError, 'the save failure line renders')
  assert.ok(texts(saveError).some((line) => line.includes('name taken')))
  const cancel = find(view.vdom, (node) => node.props?.['data-agent-roster-card-cancel'] !== undefined)
  await view.interact(() => { cancel.props.onClick() })
  const del = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-delete'] !== undefined)[0]
  await view.interact(() => { del.props.onClick() })
  const armed = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-delete'] !== undefined)[0]
  await view.interact(() => { armed.props.onClick() })
  const deleteError = find(view.vdom, (node) => node.props?.['data-agent-roster-error'] === 'roster/not-found')
  assert.ok(deleteError, 'the delete failure line renders')
  assert.ok(texts(deleteError).some((line) => line.includes('gone')))
})

test('card cancel returns to the list without writing anything', async () => {
  const view = await mountSection()
  const add = find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined)
  await view.interact(() => { add.props.onClick() })
  const cancel = find(view.vdom, (node) => node.props?.['data-agent-roster-card-cancel'] !== undefined)
  await view.interact(() => { cancel.props.onClick() })
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-card-form'] !== undefined), undefined)
  assert.equal(view.roster.saved.length, 0)
})

test('a not-ok listTemplates result renders the failure line, not the empty note', async () => {
  const view = await mountSection({
    roster: healthyRoster({ listTemplates: async () => ({ ok: false, error: { code: 'roster/storage-degraded', message: 'closed' } }) }),
  })
  const note = find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'error')
  assert.ok(note, 'the failure note renders')
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-note'] === 'empty'), undefined)
})

test('a host half without stageSpawn is reported as too old and runs no command', async () => {
  const view = await openModal({ roster: healthyRoster({ stageSpawn: undefined }) })
  await confirmModal(view)
  const banner = errorBanner(view)
  assert.ok(banner, 'the error banner renders')
  assert.ok(texts(banner).some((line) => line.includes('t:command.noStage')), 'a dedicated message, not the channel one')
  assert.deepEqual(commandLines(view), [])
})

test('a second confirm while the first is in flight stages nothing more', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const view = await openModal({ sessions: { commandResult: pending } })
  const confirmButton = () => {
    const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
    return inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  }
  await view.interact(() => { confirmButton().props.onClick() })
  assert.equal(view.roster.staged.length, 1)
  assert.equal(confirmButton().props.disabled, true, 'the confirm is disabled while in flight')
  await view.interact(() => { confirmButton().props.onClick() })
  assert.equal(view.roster.staged.length, 1, 'the guarded click stages nothing')
  release({ ok: true, value: { matched: true } })
  await view.interact()
  assert.deepEqual(commandLines(view), ['/roster'])
  assert.ok(find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'success'), 'the first request completes')
})

// ---------------------------------------------------------------------------
// Tiers and reuse: the editor fields, the row chip, the high-tier use log
// ---------------------------------------------------------------------------

/** Two newest-first high-tier use records with invented ids. */
const USE_LOG = [
  { id: 'use-2', at: '2026-11-26T09:30:00.000Z', sessionId: 'sess-9', templateId: 'tpl-reviewer', templateName: 'Reviewer', memberName: 'reviewer-diff', reason: 'task needs a deep diff read' },
  { id: 'use-1', at: '2026-11-25T16:00:00.000Z', sessionId: 'sess-8', templateId: 'tpl-researcher', templateName: 'Researcher', memberName: 'researcher-sources', reason: 'role says so' },
]

test('the form saves a high-tier model and the reuse policy', async () => {
  const view = await mountSection({ extras: { session: { modelCatalog: catalogFace } } })
  const add = find(view.vdom, (node) => node.props?.['data-agent-roster-card-add'] !== undefined)
  await view.interact(() => { add.props.onClick() })
  await typeInto(view, 'data-agent-roster-role-name', 'Market Scout')
  await typeInto(view, 'data-agent-roster-role-prompt', 'You scout markets.')
  const high = () => find(view.vdom, (node) => node.props?.['data-agent-roster-high-model'] !== undefined)
  const reuse = () => find(view.vdom, (node) => node.props?.['data-agent-roster-reuse'] !== undefined)
  const reuseTabs = () => findAll(reuse(), (node) => node.props?.role === 'tab')
  assert.equal(high().props['data-agent-roster-high-model'], 'none', 'high tier starts disabled')
  assert.equal(high().props['data-agent-roster-menu-value'], '')
  assert.ok(texts(high()).includes('t:card.highModel.none'))
  assert.deepEqual(reuseTabs().map((tab) => tab.props['aria-selected']), [true, false], 'reuse defaults to role')
  assert.deepEqual(
    reuseTabs().map((tab) => texts(tab).find((text) => text.startsWith('t:'))), ['t:card.reuse.role', 't:card.reuse.task'])
  assert.equal(find(reuse(), (node) => node.props?.role === 'tablist').props['aria-label'], 't:card.reuse')
  await pickMenuOption(view, 'data-agent-roster-card-model', JSON.stringify(['deepseek', 'chat']))
  await pickMenuOption(view, 'data-agent-roster-high-model', JSON.stringify(['deepseek', 'reasoner']))
  // Drive the real control: click the segment labelled with the task label.
  await view.interact(() => { reuseTabs().find((tab) => texts(tab).includes('t:card.reuse.task')).props.onClick() })
  assert.deepEqual(reuseTabs().map((tab) => tab.props['aria-selected']), [false, true])
  const save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  assert.deepEqual(view.roster.saved[0].defaultModel, { provider: 'deepseek', model: 'chat' })
  assert.deepEqual(view.roster.saved[0].highTierModel, { provider: 'deepseek', model: 'reasoner' })
  assert.equal(view.roster.saved[0].reuse, 'task')
})

test('edit prefills the stored high tier and reuse, and clearing the high tier saves null', async () => {
  const highRef = { provider: 'acme', model: 'custom-2', reasoningEffort: 'deep' }
  const view = await mountSection({
    roster: healthyRoster({ listTemplates: async () => ({ ok: true, value: [{ ...TEMPLATES[0], defaultModel: { provider: 'acme', model: 'custom-1' }, highTierModel: highRef, reuse: 'task' }] }) }),
  })
  const edit = find(view.vdom, (node) => node.props?.['data-agent-roster-row-edit'] !== undefined)
  await view.interact(() => { edit.props.onClick() })
  const high = find(view.vdom, (node) => node.props?.['data-agent-roster-high-model'] !== undefined)
  assert.equal(high.props['data-agent-roster-menu-value'], JSON.stringify(['acme', 'custom-2']), 'stored high tier prefills losslessly')
  const reuse = () => find(view.vdom, (node) => node.props?.['data-agent-roster-reuse'] !== undefined)
  assert.deepEqual(findAll(reuse(), (node) => node.props?.role === 'tab').map((tab) => tab.props['aria-selected']), [false, true])
  // The menu's none row has key '' (ModelMenu noneLabel entry).
  await pickMenuOption(view, 'data-agent-roster-high-model', '')
  const save = find(view.vdom, (node) => node.props?.['data-agent-roster-card-save'] !== undefined)
  await view.interact(() => { save.props.onClick() })
  assert.equal(view.roster.saved[0].highTierModel, null, 'an explicit null clears the stored high tier')
  assert.equal(view.roster.saved[0].reuse, 'task')
})

test('a template row shows the base model and names the high tier when set', async () => {
  const view = await mountSection({
    roster: healthyRoster({ listTemplates: async () => ({ ok: true, value: [
      { ...TEMPLATES[0], defaultModel: { provider: 'acme', model: 'custom-1' }, highTierModel: { provider: 'acme', model: 'custom-2' } },
      { ...TEMPLATES[1], defaultModel: null, highTierModel: null },
    ] }) }),
  })
  const chips = findAll(view.vdom, (node) => node.props?.['data-agent-roster-row-model'] !== undefined)
  assert.ok(texts(chips[0]).includes('t:card.model.chip.high(model=t:card.model.chip(provider=acme,model=custom-1))'), 'a set high tier is named after the base')
  assert.ok(texts(chips[1]).includes('t:card.model.none'))
  assert.equal(texts(chips[1]).some((line) => line.includes('chip.high')), false, 'no arrow without a high tier')
})

test('the high-tier use block lists records with their reason, or the empty note', async () => {
  const view = await mountSection({ roster: healthyRoster({ listHighTierUse: async () => ({ ok: true, value: USE_LOG }) }) })
  const block = find(view.vdom, (node) => node.props?.['data-agent-roster-use'] !== undefined)
  assert.ok(block, 'the use block renders')
  const settings = find(view.vdom, (node) => node.props?.['data-agent-roster-settings'] !== undefined)
  const positions = ['data-agent-roster-card', 'data-agent-roster-use'].map((marker) =>
    settings.children.findIndex((child) => child.props?.[marker] !== undefined))
  assert.deepEqual(positions.map((position) => position !== -1), [true, true])
  assert.ok(positions[1] > positions[0], 'the use block renders after the manager')
  assert.ok(texts(block).includes('t:card.use.title'))
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-use-empty'] !== undefined), undefined, 'no empty note over records')
  const rows = findAll(view.vdom, (node) => node.props?.['data-agent-roster-use-row'] !== undefined)
  assert.deepEqual(rows.map((node) => node.props['data-agent-roster-use-row']), ['use-2', 'use-1'], 'records keep the newest-first order of the host')
  assert.ok(texts(rows[0]).includes('t:card.use.row(template=Reviewer,member=reviewer-diff,time=2026-11-26T09:30:00.000Z)'))
  assert.deepEqual(
    findAll(view.vdom, (node) => node.props?.['data-agent-roster-use-reason'] !== undefined)
      .map((node) => texts(node).find((line) => line.startsWith('t:card.use.reason('))),
    ['t:card.use.reason(reason=task needs a deep diff read)', 't:card.use.reason(reason=role says so)'])
})

test('the high-tier use block shows the empty note without records and the failure line when the read fails', async () => {
  const empty = await mountSection()
  assert.ok(find(empty.vdom, (node) => node.props?.['data-agent-roster-use-empty'] !== undefined), 'the empty note renders')
  assert.equal(find(empty.vdom, (node) => node.props?.['data-agent-roster-use-row'] !== undefined), undefined)
  const failed = await mountSection({
    roster: healthyRoster({ listHighTierUse: async () => ({ ok: false, error: { code: 'roster/storage-degraded', message: 'closed' } }) }),
  })
  const line = find(failed.vdom, (node) => node.props?.['data-agent-roster-error'] === 'roster/storage-degraded')
  assert.ok(line, 'the failed read renders its error line')
  assert.ok(texts(line).some((text) => text.includes('closed')))
  assert.equal(find(failed.vdom, (node) => node.props?.['data-agent-roster-use-empty'] !== undefined), undefined, 'a failure is not "no records"')
})

test('the high-tier none label and the reuse labels read as real bilingual copy in both dictionaries', () => {
  const { recorded } = applyPlugin({})
  const { zh, en } = recorded.namespaces[0].dicts
  for (const [dict, none, role, task, title] of [
    [zh, '未启用高阶', '按角色复用', '按任务复用', '高阶使用记录'],
    [en, 'High tier not enabled', 'By role', 'By task', 'High-tier use'],
  ]) {
    assert.equal(dict['card.highModel.none'], none)
    assert.equal(dict['card.reuse.role'], role)
    assert.equal(dict['card.reuse.task'], task)
    assert.equal(dict['card.use.title'], title)
    assert.equal(dict['card.model.chip.high'], '{model} → ' + (dict === zh ? '高阶' : 'high'))
  }
})
