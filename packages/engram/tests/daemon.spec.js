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
