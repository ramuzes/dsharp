/**
 * Host-half scaffold tests (Task 1): config unwrap discipline, the staged
 * status writer, and the apply() boot sequence.
 *
 * Fakes mirror real strictness (AGENTS.md): the fake ctx exposes ONLY the
 * framework members a scaffold may touch (inject / effect) — any other
 * property access throws exactly like cordis does for a non-injected service
 * ("cannot get property ... without inject"; engram tests/host.spec.js
 * makeFakeHost/makeScope pattern) — and config fields are schemastery-style
 * reactive wrappers `{ get: () => value }`, the exact shape the Loader hands
 * the plugin (AGENTS.md, "Config values arrive wrapped").
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply } from '../index.js'
import { readString, readBoolean } from '../lib/wire.js'

/** Unwrap rule the host code itself uses (defensive: wrapper or plain). */
const unwrap = (v) => typeof v?.get === 'function' ? v.get() : v

/**
 * Fake host: a ctx that carries only the framework surface (inject, effect);
 * everything else throws like a non-injected service access in cordis.
 */
function makeFakeHost() {
  const injects = []
  const effects = []
  const framework = {
    inject: (names, fn) => { injects.push({ names, fn }) },
    // Real ctx.effect runs the body synchronously and keeps the returned
    // disposer for fiber disposal (cordis fiber.d.ts effect(execute, label)).
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
  }
  const ctx = new Proxy(framework, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
  return { ctx, injects, effects }
}

test('apply reads config through wrappers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-roster-t1-'))
  const file = join(dir, 'status.json')
  const prev = process.env.AGENT_ROSTER_STATUS_FILE
  process.env.AGENT_ROSTER_STATUS_FILE = file
  try {
    let wrapperReads = 0
    const config = {
      exposeAgentTools: { get: () => { wrapperReads += 1; return true } },
    }
    const host = makeFakeHost()
    await apply(host.ctx, config)
    // Scaffold registers no services yet (Task 2+ add the store/service/tools).
    assert.equal(host.injects.length, 0, 'no inject callback registered')
    assert.equal(host.effects.length, 1, 'wiring wrapped in exactly one ctx.effect')
    assert.ok(wrapperReads >= 1, 'exposeAgentTools must be read through the wrapper getter')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'done', 'stage sequence ends with a done record')
    assert.equal(typeof record.at, 'string')
    assert.ok(!Number.isNaN(Date.parse(record.at)))
  } finally {
    // Assigning undefined to process.env stores the STRING "undefined";
    // delete instead (engram test precedent).
    if (prev === undefined) delete process.env.AGENT_ROSTER_STATUS_FILE
    else process.env.AGENT_ROSTER_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readString/readBoolean unwrap reactive wrappers and pass plain values through', () => {
  assert.equal(readString('plain'), 'plain')
  assert.equal(readString({ get: () => 'wrapped' }), 'wrapped')
  assert.equal(readString(42), '')                     // wrong type → ''
  assert.equal(readString(undefined), '')
  assert.equal(readBoolean(true), true)
  assert.equal(readBoolean(false), false)
  assert.equal(readBoolean({ get: () => true }), true)
  assert.equal(readBoolean({ get: () => false }), false)
  assert.equal(readBoolean('true'), false)             // strict boolean: wrong type → false
  assert.equal(readBoolean(undefined), false)
})

test('Config parses {} to exposeAgentTools: true', () => {
  const parsed = Config({})
  assert.equal(unwrap(parsed.exposeAgentTools), true)
  // Structural (non-volatile) per the plan: edits reload the plugin rather
  // than applying live, so the field parses as a plain value, not a wrapper.
  assert.equal(typeof parsed.exposeAgentTools?.get, 'undefined')
})
