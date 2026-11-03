import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideApproval, registerApprovalGate, DEFAULT_READ_ONLY_TOOLS, TOOL_PREFIX, APPROVAL_POLICIES } from '../lib/gate.js'

test('sensitive policy: read-only tools pass, others ask', () => {
  const s = { policy: 'sensitive', readOnlyTools: DEFAULT_READ_ONLY_TOOLS }
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'take_snapshot'), { kind: 'allow' })
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'list_pages'), { kind: 'allow' })
  const d = decideApproval(s, TOOL_PREFIX + 'navigate_page')
  assert.equal(d.kind, 'ask')
  assert.ok(d.reason.includes('navigate_page'))
  assert.equal(typeof d.displayReason.zh, 'string')
  assert.equal(typeof d.displayReason.en, 'string')
})

test('all policy: even read-only tools ask', () => {
  const d = decideApproval({ policy: 'all', readOnlyTools: DEFAULT_READ_ONLY_TOOLS }, TOOL_PREFIX + 'take_screenshot')
  assert.equal(d.kind, 'ask')
})

test('none policy: everything allows', () => {
  assert.deepEqual(decideApproval({ policy: 'none', readOnlyTools: [] }, TOOL_PREFIX + 'click'), { kind: 'allow' })
})

test('off-prefix names allow (listener filters, decision is total)', () => {
  assert.deepEqual(decideApproval({ policy: 'sensitive', readOnlyTools: [] }, 'bash'), { kind: 'allow' })
  assert.deepEqual(decideApproval({ policy: 'sensitive', readOnlyTools: [] }, 'mcp__other__x'), { kind: 'allow' })
})

test('custom read-only list replaces the default wholesale', () => {
  const s = { policy: 'sensitive', readOnlyTools: ['take_snapshot'] }
  assert.equal(decideApproval(s, TOOL_PREFIX + 'list_pages').kind, 'ask')
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'take_snapshot'), { kind: 'allow' })
})

test('listener: off-prefix delegates via next(), in-prefix asks, allow delegates', async () => {
  const registered = []
  const ctx = { on: (name, fn) => { registered.push({ name, fn }); return () => {} } }
  let settings = { policy: 'sensitive', readOnlyTools: DEFAULT_READ_ONLY_TOOLS }
  registerApprovalGate(ctx, () => settings)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'tools/pre-execute')
  const gate = registered[0].fn
  let delegated = 0
  const next = async () => { delegated++; return { kind: 'allow' } }
  // off-prefix -> next()
  const r1 = await gate({ name: 'bash', arguments: {} }, next)
  assert.equal(delegated, 1)
  // read-only -> next()
  await gate({ name: TOOL_PREFIX + 'take_snapshot' }, next)
  assert.equal(delegated, 2)
  // sensitive -> ask, no delegation
  const r3 = await gate({ name: TOOL_PREFIX + 'click' }, next)
  assert.equal(delegated, 2)
  assert.equal(r3.kind, 'ask')
})

test('listener reads settings fresh per call (volatile liveness)', async () => {
  const registered = []
  const ctx = { on: (n, fn) => { registered.push({ name: n, fn }); return () => {} } }
  let policy = 'sensitive'
  registerApprovalGate(ctx, () => ({ policy, readOnlyTools: [] }))
  const gate = registered[0].fn
  const next = async () => ({ kind: 'allow' })
  assert.equal((await gate({ name: TOOL_PREFIX + 'click' }, next)).kind, 'ask')
  policy = 'none'
  assert.deepEqual(await gate({ name: TOOL_PREFIX + 'click' }, next), { kind: 'allow' })
})

test('listener never throws on malformed payloads', async () => {
  const registered = []
  const ctx = { on: (n, fn) => { registered.push({ name: n, fn }); return () => {} } }
  registerApprovalGate(ctx, () => ({ policy: 'sensitive', readOnlyTools: [] }))
  const gate = registered[0].fn
  const next = async () => ({ kind: 'allow' })
  for (const bad of [undefined, null, {}, { name: 42 }, { name: null }]) {
    const r = await gate(bad, next)
    assert.deepEqual(r, { kind: 'allow' })
  }
})

test('default read-only list matches the documented surface', () => {
  assert.ok(DEFAULT_READ_ONLY_TOOLS.includes('take_snapshot'))
  assert.ok(!DEFAULT_READ_ONLY_TOOLS.includes('navigate_page'))
  assert.equal(new Set(DEFAULT_READ_ONLY_TOOLS).size, DEFAULT_READ_ONLY_TOOLS.length)
  assert.deepEqual([...APPROVAL_POLICIES], ['sensitive', 'all', 'none'])
})
