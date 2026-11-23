// Tests for daemon stewardship. The subprocess fake mirrors the real
// packages/subprocess seam strictly (AGENTS.md rule 1): `SubprocessOutcome`
// carries ONLY `{ exitCode, signal }` — no success flag, no stderr field —
// and collected stderr text is readable only through
// `handle.collected.stderr.readFrom(0)` after settlement, exactly as
// packages/subprocess/subprocess/src/types.ts specifies. A fake looser than
// that would let the failure check rely on members that do not exist.
import test from 'node:test'
import assert from 'node:assert/strict'

import { EngramError } from '../lib/engram-api.js'
import { ensureDaemon } from '../lib/daemon.js'

/**
 * Strict fake subprocess: spawn(spec) records the spec and returns
 * `{ done: Promise<SubprocessOutcome-shaped object> }`. The outcome shape is
 * exactly SubprocessOutcome; stderr text arrives through a collected reader.
 */
function makeSubprocess(handler) {
  const specs = []
  const spawn = (spec) => {
    // Mirror the real seam's synchronous validation (dsh
    // packages/subprocess/subprocess-local/src/spawn.ts:165-167): a spec
    // without a valid graceMs is rejected BEFORE launch. A fake that skipped
    // this let a graceMs-less spec pass the whole suite while every real
    // spawn failed (2026-11-23 outage; AGENTS.md §1: fakes must replicate
    // real strictness).
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > 2147483647) {
      throw new Error('subprocess graceMs must be a positive finite number no greater than 2147483647')
    }
    specs.push(spec)
    return handler(spec, specs.length)
  }
  spawn.specs = specs
  return { spawn }
}

/** A settled-collect handle: exit facts + a collected stderr reader. */
function makeHandle({ exitCode, signal = null, stderrText = '' }) {
  return {
    done: Promise.resolve({ exitCode, signal }),
    collected: {
      stderr: {
        readFrom: (fromByte) => ({
          text: fromByte === 0 ? stderrText : stderrText.slice(fromByte),
          nextOffset: stderrText.length,
          lossy: false,
        }),
      },
    },
  }
}

const supportedHealth = () => ({
  version: '3.7.2',
  capabilities: { observations: true },
})
const oldHealth = () => ({ version: '3.6.1', capabilities: {} })

const noopNote = () => {}

/** Notes fake capturing (stage, detail) pairs — mirrors status.js `note(stage, detail?)`. */
function makeNotes() {
  const entries = []
  return { entries, note: (stage, detail) => entries.push({ stage, detail }) }
}

const baseRetry = { attempts: 2, delayMs: 0 }

/** Probe fake returning the listed values in order (last one repeats). */
function probeSequence(values) {
  let call = 0
  return async () => {
    const value = values[Math.min(call, values.length - 1)]
    call += 1
    if (value instanceof Error) throw value
    return value
  }
}

test('a: healthy supported daemon returns health without spawning', async () => {
  const subprocess = makeSubprocess(() => {
    throw new Error('spawn must not be called when the daemon is healthy')
  })
  const note = () => { throw new Error('note must not fire without a spawn') }
  const health = await ensureDaemon({
    client: {},
    probe: probeSequence([supportedHealth()]),
    subprocess,
    spawnEnabled: true,
    buildEnv: () => { throw new Error('buildEnv must not be called') },
    note,
    retry: baseRetry,
  })
  assert.deepEqual(health, supportedHealth())
  assert.equal(subprocess.spawn.specs.length, 0)
})

test('b: healthy but unsupported version throws engram/unsupported-version mentioning >=3.7', async () => {
  const subprocess = makeSubprocess(() => {
    throw new Error('spawning cannot fix a version mismatch')
  })
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([oldHealth()]),
      subprocess,
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: noopNote,
      retry: baseRetry,
    }),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/unsupported-version')
      assert.ok(err.message.includes('3.6.1'))
      assert.ok(err.message.includes('>=3.7'))
      return true
    },
  )
})

test('c: unreachable with spawnEnabled false throws engram/daemon-unreachable with instructive text', async () => {
  const fail = new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([fail]),
      subprocess: makeSubprocess(() => {
        throw new Error('spawn is disabled')
      }),
      spawnEnabled: false,
      buildEnv: () => ({}),
      note: noopNote,
      retry: baseRetry,
    }),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/daemon-unreachable')
      // Instructive text: names the configured port and the daemonMode switch.
      assert.ok(err.message.includes('configured port'))
      assert.ok(err.message.includes('daemon.port'))
      assert.ok(err.message.includes('daemonMode'))
      assert.ok(err.message.includes('connect-only'))
      return true
    },
  )
})

test('d: unreachable + spawn runs engram run -d with buildEnv output, then probe succeeds', async () => {
  const envSentinel = { ENGRAM_TEST: '1' }
  const subprocess = makeSubprocess((_spec, nth) => {
    assert.equal(nth, 1, 'exactly one spawn expected')
    return makeHandle({ exitCode: 0 })
  })
  let probes = 0
  const probe = async () => {
    probes += 1
    if (probes === 1) throw new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')
    return supportedHealth()
  }
  const health = await ensureDaemon({
    client: {},
    probe,
    subprocess,
    spawnEnabled: true,
    buildEnv: () => envSentinel,
    note: noopNote,
    retry: { attempts: 3, delayMs: 0 },
  })
  assert.deepEqual(health, supportedHealth())
  const spec = subprocess.spawn.specs[0]
  assert.deepEqual(spec.argv, ['engram', 'run', '-d'])
  assert.equal(spec.env, envSentinel)
  // stdio is explicit per-stream per SubprocessSpawnSpec, stderr collectable.
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.equal(spec.stdio.stdout, 'inherit')
  assert.equal(typeof spec.stdio.stderr.maxBytes, 'number')
})

test('e: spawn exits nonzero with lock/port stderr text -> engram/daemon-spawn-failed advising port or connect-only', async () => {
  const subprocess = makeSubprocess(() => makeHandle({
    exitCode: 1,
    stderrText: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:7437 (lock held)',
  }))
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')]),
      subprocess,
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: noopNote,
      retry: baseRetry,
    }),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/daemon-spawn-failed')
      assert.ok(err.message.includes('EADDRINUSE'))
      assert.ok(err.message.includes('daemon.port'))
      assert.ok(err.message.includes('connect-only'))
      return true
    },
  )
})

test('f: probe never succeeds within attempts throws engram/daemon-unreachable', async () => {
  const fail = new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')
  const probe = probeSequence([fail])
  let probeCalls = 0
  const countingProbe = async () => { probeCalls += 1; return probe() }
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: countingProbe,
      subprocess: makeSubprocess(() => makeHandle({ exitCode: 0 })),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: noopNote,
      retry: { attempts: 3, delayMs: 0 },
    }),
    (err) => err instanceof EngramError && err.code === 'engram/daemon-unreachable',
  )
  // First attempt + retries up to the configured attempts, then give up.
  assert.equal(probeCalls, 3)
})

test('g: success after spawn calls note(daemon-spawned)', async () => {
  const notes = []
  const probe = probeSequence([
    new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed'),
    supportedHealth(),
  ])
  const health = await ensureDaemon({
    client: {},
    probe,
    subprocess: makeSubprocess(() => makeHandle({ exitCode: 0 })),
    spawnEnabled: true,
    buildEnv: () => ({}),
    note: (tag) => notes.push(tag),
    retry: { attempts: 2, delayMs: 0 },
  })
  assert.deepEqual(health, supportedHealth())
  assert.deepEqual(notes, ['daemon-spawned'])
})

test('g2: healthy-first path does not call note', async () => {
  const notes = []
  await ensureDaemon({
    client: {},
    probe: probeSequence([supportedHealth()]),
    subprocess: makeSubprocess(() => makeHandle({ exitCode: 0 })),
    spawnEnabled: true,
    buildEnv: () => ({}),
    note: (tag) => notes.push(tag),
    retry: baseRetry,
  })
  assert.deepEqual(notes, [])
})

test('spawn whose done rejects (provider failure) -> engram/daemon-spawn-failed, never raw', async () => {
  const subprocess = makeSubprocess(() => ({
    done: Promise.reject(new Error('provider exploded')),
    collected: {},
  }))
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')]),
      subprocess,
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: noopNote,
      retry: baseRetry,
    }),
    (err) => err instanceof EngramError && err.code === 'engram/daemon-spawn-failed',
  )
})

// ---- final-review: every failure stage lands in the status file -----------

test('h: spawn failure (port collision) notes daemon-spawn-failed with the guidance', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')]),
      subprocess: makeSubprocess(() => makeHandle({
        exitCode: 1,
        stderrText: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:7437',
      })),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: notes.note,
      retry: baseRetry,
    }),
    (err) => err.code === 'engram/daemon-spawn-failed',
  )
  assert.equal(notes.entries.length, 1)
  assert.equal(notes.entries[0].stage, 'daemon-spawn-failed')
  assert.ok(notes.entries[0].detail.includes('EADDRINUSE'))
  assert.ok(notes.entries[0].detail.includes('daemon.port'), 'guidance in the noted detail')
  assert.ok(notes.entries[0].detail.includes('connect-only'))
})

test('h2: provider-level spawn failure also notes daemon-spawn-failed', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')]),
      subprocess: makeSubprocess(() => ({ done: Promise.reject(new Error('provider exploded')), collected: {} })),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: notes.note,
      retry: baseRetry,
    }),
    (err) => err.code === 'engram/daemon-spawn-failed',
  )
  assert.equal(notes.entries.length, 1)
  assert.equal(notes.entries[0].stage, 'daemon-spawn-failed')
  assert.ok(notes.entries[0].detail.includes('provider exploded'))
})

test('i: terminal unreachable after retry exhaustion notes daemon-unreachable', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')]),
      subprocess: makeSubprocess(() => makeHandle({ exitCode: 0 })),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: notes.note,
      retry: { attempts: 2, delayMs: 0 },
    }),
    (err) => err.code === 'engram/daemon-unreachable',
  )
  assert.equal(notes.entries.length, 1)
  assert.equal(notes.entries[0].stage, 'daemon-unreachable')
  assert.ok(notes.entries[0].detail.includes('did not become reachable'))
})

test('j: connect-only unreachable notes daemon-unreachable', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([new EngramError('engram/unreachable', 'engram/unreachable: request to /health failed')]),
      subprocess: makeSubprocess(() => { throw new Error('spawn is disabled') }),
      spawnEnabled: false,
      buildEnv: () => ({}),
      note: notes.note,
      retry: baseRetry,
    }),
    (err) => err.code === 'engram/daemon-unreachable',
  )
  assert.equal(notes.entries.length, 1)
  assert.equal(notes.entries[0].stage, 'daemon-unreachable')
  assert.ok(notes.entries[0].detail.includes('configured port'))
})

test('k: unsupported version notes daemon-unsupported-version with found vs >=3.7', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([oldHealth()]),
      subprocess: makeSubprocess(() => { throw new Error('spawning cannot fix a version mismatch') }),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: notes.note,
      retry: baseRetry,
    }),
    (err) => err.code === 'engram/unsupported-version',
  )
  assert.equal(notes.entries.length, 1)
  assert.equal(notes.entries[0].stage, 'daemon-unsupported-version')
  assert.ok(notes.entries[0].detail.includes('3.6.1'))
  assert.ok(notes.entries[0].detail.includes('>=3.7'))
})

// ---- final-review: capability gate ----------------------------------------

test('l: /health without capabilities -> typed engram/unsupported-version naming the gap + note', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([{ version: '3.7.2' }]), // no capabilities field
      subprocess: makeSubprocess(() => { throw new Error('spawning cannot fix capabilities') }),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: notes.note,
      retry: baseRetry,
    }),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/unsupported-version')
      assert.ok(err.message.includes('capabilit'), 'message names the capability gap')
      return true
    },
  )
  assert.equal(notes.entries.length, 1)
  assert.equal(notes.entries[0].stage, 'daemon-unsupported-version')
})

test('l2: /health with EMPTY capabilities object -> same typed error', async () => {
  const notes = makeNotes()
  await assert.rejects(
    ensureDaemon({
      client: {},
      probe: probeSequence([{ version: '3.8.0', capabilities: {} }]),
      subprocess: makeSubprocess(() => { throw new Error('spawning cannot fix capabilities') }),
      spawnEnabled: true,
      buildEnv: () => ({}),
      note: notes.note,
      retry: baseRetry,
    }),
    (err) => err.code === 'engram/unsupported-version' && err.message.includes('capabilit'),
  )
  assert.equal(notes.entries[0].stage, 'daemon-unsupported-version')
})

test('the daemon spawn spec carries a graceMs the real seam accepts', async () => {
  // Regression for the 2026-11-23 outage: lib/daemon.js omitted graceMs,
  // which dsh validates before launch (subprocess-local/src/spawn.ts:165-167).
  // The fake in this file now rejects such a spec, so the spawn below fails
  // with engram/daemon-spawn-failed if the member goes missing again.
  const subprocess = makeSubprocess(() => makeHandle({ exitCode: 0 }))
  const health = await ensureDaemon({
    client: {},
    probe: probeSequence([new Error('daemon down'), supportedHealth()]),
    subprocess,
    spawnEnabled: true,
    buildEnv: () => ({}),
    note: noopNote,
    retry: baseRetry,
  })
  assert.deepEqual(health, supportedHealth())
  assert.equal(subprocess.spawn.specs.length, 1)
  const { graceMs } = subprocess.spawn.specs[0]
  assert.ok(Number.isInteger(graceMs) && graceMs > 0 && graceMs <= 2147483647, `graceMs must be a positive safe integer, got ${String(graceMs)}`)
})
