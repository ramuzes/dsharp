/**
 * Task 1 scaffold tests: Config schema defaults (ADR-0005 — empty or
 * protocol-generic, no deployment values) and the staged status writer
 * (best-effort, never fatal).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, readString, readNumber } from '../index.js'
import { makeStatusWriter } from '../lib/status.js'

/**
 * Volatile fields parse as schemastery reactive wrappers — the exact shape
 * the Loader hands the plugin (AGENTS.md). Assert defaults through the same
 * unwrap rule the host code uses.
 */
const unwrap = (v) => typeof v?.get === 'function' ? v.get() : v

test('Config defaults are empty/generic (ADR-0005)', () => {
  const parsed = Config({})
  assert.equal(unwrap(parsed.daemonMode), 'auto-spawn')          // protocol-generic default ok
  assert.equal(unwrap(parsed.port), '')                          // '' = engram's documented protocol default 7437; not baked
  assert.equal(unwrap(parsed.httpTokenRef), '')                  // credential-ref name, empty = no auth
  assert.equal(unwrap(parsed.cloudServerRef), '')                // credential references, empty
  assert.equal(unwrap(parsed.cloudTokenRef), '')
  assert.equal(unwrap(parsed.autosync), false)
  assert.equal(unwrap(parsed.contextInjection), 'off')
  assert.equal(unwrap(parsed.contextMaxBytes), 2048)
  assert.equal(unwrap(parsed.projectMode), 'auto')
  assert.equal(unwrap(parsed.fixedProject), '')
  assert.deepEqual(unwrap(parsed.projectMap), {})
  assert.equal(unwrap(parsed.toolProfile), 'core')
})

test('volatile fields are marked hot-editable in the schema', () => {
  const parsed = Config({})
  // Every hot-editable field parses as a reactive wrapper (hot-editable).
  for (const key of ['port', 'httpTokenRef', 'cloudServerRef', 'cloudTokenRef', 'autosync',
    'contextInjection', 'contextMaxBytes', 'projectMode', 'fixedProject', 'projectMap', 'toolProfile']) {
    assert.equal(typeof parsed[key]?.get, 'function', `${key} should parse as a reactive (hot-editable) wrapper`)
  }
  // daemonMode is deliberately NOT volatile: it changes mount-time structure.
  assert.equal(typeof parsed.daemonMode?.get, 'undefined')
})

test('readString/readNumber unwrap schemastery reactive wrappers', () => {
  assert.equal(readString('plain'), 'plain')
  assert.equal(readString({ get: () => 'wrapped' }), 'wrapped')
  assert.equal(readString(42), '')                        // wrong type → ''
  assert.equal(readNumber({ get: () => 7 }), 7)
  assert.equal(readNumber('7'), Number.NaN)               // wrong type → NaN
  assert.equal(readNumber(undefined), Number.NaN)
})

test('makeStatusWriter writes staged records to the given file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-status-'))
  const file = join(dir, 'status.json')
  try {
    const writer = makeStatusWriter(file)
    writer.note('apply')
    writer.note('inject', 'tools registered')
    const first = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(first.stage, 'inject')
    assert.equal(first.detail, 'tools registered')
    assert.equal(typeof first.at, 'string')
    assert.ok(!Number.isNaN(Date.parse(first.at)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('makeStatusWriter never throws on an unwritable path', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'engram-status-')), 'no-such-dir', 'status.json')
  const writer = makeStatusWriter(file)
  assert.doesNotThrow(() => writer.note('apply'))
})
