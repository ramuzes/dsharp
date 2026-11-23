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
function primitives() {
  return { Modal, IconPlusOutlineRegular, MenuSurface, MenuGroup, IconChevronDownOutlineRegular, IconCheckOutlineRegular }
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
  // The sessions fake mirrors the real contract: using(target, options,
  // operation) hands back a reference whose binding.session.prompt(content,
  // mode) is the composer-equivalent admission. Both hops are recorded.
  const sessionCalls = []
  const sessions = {
    calls: sessionCalls,
    fail: sessionsConfig?.fail ?? null,
    promptResult: sessionsConfig?.promptResult ?? { ok: true, value: { accepted: true } },
    promptError: sessionsConfig?.promptError ?? null,
    using: async (target, options, operation) => {
      sessionCalls.push({ target, options })
      if (sessions.fail !== null) throw sessions.fail
      return operation({
        binding: {
          session: {
            prompt: async (content, mode) => {
              sessionCalls.push({ content, mode })
              if (sessions.promptError !== null) throw sessions.promptError
              return sessions.promptResult
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

/** The healthy roster face: CRUD only — the plugin's whole remote surface. */
function healthyRoster(overrides = {}) {
  const saved = []
  const deleted = []
  const face = {
    saved,
    deleted,
    listTemplates: async () => ({ ok: true, value: TEMPLATES }),
    saveTemplate: async (input) => {
      saved.push(input)
      return { ok: true, value: { ...TEMPLATES[0], ...input, id: input.id ?? 'tpl-new' } }
    },
    deleteTemplate: async (id) => { deleted.push(id); return { ok: true, value: { deleted: true } } },
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
  assert.equal(t('inject.sent', { name: 'Reviewer' }), 't:inject.sent(name=Reviewer)')
})

test('apply mounts the agentRoster remote namespace with exactly three method descriptors', () => {
  const { recorded } = applyPlugin({})
  assert.equal(recorded.mounts.length, 1)
  const mount = recorded.mounts[0]
  assert.equal(mount.package, 'dsh-agent-roster')
  assert.deepEqual(mount.descriptors.map((d) => d.method).sort(), ['deleteTemplate', 'listTemplates', 'saveTemplate'])
})

// ---------------------------------------------------------------------------
// The "+" modal — instruction composition and injection
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
  assert.deepEqual(root.children.map((child) => child.props['data-agent-roster-section']),
    ['templates', 'preview', 'task'])
  const cancel = inModal(modal, (node) => node.props?.['data-agent-roster-cancel'] !== undefined)
  await view.interact(() => { cancel.props.onClick() })
  assert.equal(find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node), undefined)
})

test('the modal lists templates, auto-selects the first, and previews the exact instruction', async () => {
  const view = await openModal()
  const rows = findAll(view.vdom, (node) => typeof node.props?.['data-agent-roster-template'] === 'string')
  assert.deepEqual(rows.map((row) => row.props['data-agent-roster-template']), ['tpl-researcher', 'tpl-reviewer'])
  assert.equal(rows[0].props['aria-selected'], 'true')
  assert.equal(rows[1].props['aria-selected'], 'false')
  const preview = find(view.vdom, (node) => node.props?.['data-agent-roster-preview'] !== undefined)
  assert.ok(preview, 'the instruction preview renders')
  const instruction = preview.children[0]
  // Pinned shape (SPEC §Design): template identity, frozen standing prompt,
  // the exact tool call, and the no-rewrite instruction. No task line yet.
  assert.ok(instruction.startsWith('Use the agent-roster template «Researcher» to create a team member for me.'))
  assert.ok(instruction.includes('Template description: Finds and reads sources'))
  assert.ok(instruction.includes('Standing instruction the member must run with (do not rewrite it):\n---\nYou research topics thoroughly.\n---'))
  assert.ok(instruction.includes('Call the roster_spawn tool with template: "tpl-researcher" (omit task).'))
  assert.ok(instruction.includes('Do not describe the member in chat instead of creating it'))
  assert.equal(instruction.includes('Current task for this member:'), false)
})

test('picking another template re-renders the preview for that template', async () => {
  const view = await openModal()
  const reviewer = find(view.vdom, (node) => node.props?.['data-agent-roster-template'] === 'tpl-reviewer')
  await view.interact(() => { reviewer.props.onClick() })
  const preview = find(view.vdom, (node) => node.props?.['data-agent-roster-preview'] !== undefined)
  const instruction = preview.children[0]
  assert.ok(instruction.includes('«Reviewer»'))
  assert.ok(instruction.includes('template: "tpl-reviewer"'))
  assert.ok(instruction.includes('You review diffs critically.'))
})

test('the task field is appended to the instruction and to the tool-call line', async () => {
  const view = await openModal()
  await typeInto(view, 'data-agent-roster-task', '  review the payments module  ')
  const preview = find(view.vdom, (node) => node.props?.['data-agent-roster-preview'] !== undefined)
  const instruction = preview.children[0]
  assert.ok(instruction.includes('Current task for this member: review the payments module'))
  assert.ok(instruction.includes('and the current task text above as task'))
  assert.equal(instruction.includes('(omit task)'), false)
})

test('confirm injects the instruction through sessions.using → prompt(queue) and reports success', async () => {
  const view = await openModal()
  await typeInto(view, 'data-agent-roster-task', 'review the payments module')
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  const confirm = inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined)
  assert.equal(confirm.props.disabled, false)
  await view.interact(() => { confirm.props.onClick() })
  const calls = view.sessions.calls
  assert.equal(calls.length, 2, 'using() plus the prompt() call')
  assert.equal(calls[0].target, 'sess-1')
  assert.deepEqual(calls[0].options, { source: 'agent-roster' })
  assert.equal(calls[1].mode, 'queue')
  assert.equal(calls[1].content.length, 1)
  assert.equal(calls[1].content[0].type, 'text')
  assert.ok(calls[1].content[0].text.includes('template: "tpl-researcher"'))
  assert.ok(calls[1].content[0].text.includes('Current task for this member: review the payments module'))
  // Success banner names the template; no spawn happened plugin-side.
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'success')
  assert.ok(banner, 'the success banner renders')
  assert.ok(texts(banner).some((line) => line === 't:inject.sent(name=Researcher)'))
  assert.equal(view.roster.saveTemplate === undefined, false)
})

test('a rejected prompt renders the error line and keeps the modal open', async () => {
  const view = await openModal({ sessions: { promptResult: { ok: false, error: { code: 'session/agent-busy', message: 'agent busy' } } } })
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'error')
  assert.ok(banner, 'the error banner renders')
  assert.equal(banner.props['data-agent-roster-error'], 'session/agent-busy')
  assert.ok(texts(banner).some((line) => line.includes('t:inject.failed')))
  assert.ok(texts(banner).some((line) => line.includes('agent busy')))
  assert.ok(find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node), 'still open')
})

test('an unavailable sessions service degrades to the unavailable error, never a crash', async () => {
  const view = await openModal({ sessions: { fail: new Error('sessions unavailable') } })
  const modal = find(view.vdom, (node) => node.props?.['data-fake-modal'] !== undefined && node)
  await view.interact(() => { inModal(modal, (node) => node.props?.['data-agent-roster-confirm'] !== undefined).props.onClick() })
  const banner = find(view.vdom, (node) => node.props?.['data-agent-roster-banner'] === 'error')
  assert.ok(banner, 'the error banner renders')
  assert.ok(texts(banner).some((line) => line.includes('t:inject.failed')))
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
  assert.equal(find(view.vdom, (node) => node.props?.['data-agent-roster-preview'] !== undefined), undefined)
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