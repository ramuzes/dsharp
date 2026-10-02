/**
 * Tests for the terminal PTY env stamping added alongside the executor
 * subclass. Run: node --test packages/workspace-env/tests/terminal-env.spec.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { stampTerminalEnv, patchSubprocessTerminals } = await import('../index.js')

/** Run body with one DSH_* env value set, restoring the previous state. */
function withEnv(name, value, body) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('stampTerminalEnv stamps every enabled toolchain under the given root', () => {
  withEnv('DSH_WORKSPACE_ENV_TOOLS', undefined, () => {
    assert.deepEqual(stampTerminalEnv('/ws', undefined), {
      UV_CACHE_DIR: '/ws/.uv-cache/cache',
      UV_PYTHON_INSTALL_DIR: '/ws/.uv-cache/python',
      GOCACHE: '/ws/.go-cache/build',
      GOMODCACHE: '/ws/.go-cache/mod',
      GOTELEMETRYDIR: '/ws/.go-cache/telemetry',
    })
  })
})

test('stampTerminalEnv keeps explicit entries and custom dirnames', () => {
  withEnv('DSH_GO_CACHE_DIRNAME', '.gocache', () => {
    assert.deepEqual(
      stampTerminalEnv('/ws', { GOCACHE: '/custom/gocache' }),
      {
        UV_CACHE_DIR: '/ws/.uv-cache/cache',
        UV_PYTHON_INSTALL_DIR: '/ws/.uv-cache/python',
        GOMODCACHE: '/ws/.gocache/mod',
        GOTELEMETRYDIR: '/ws/.gocache/telemetry',
      },
    )
  })
})

test('stampTerminalEnv honors DSH_WORKSPACE_ENV_TOOLS=go', () => {
  withEnv('DSH_WORKSPACE_ENV_TOOLS', 'go', () => {
    assert.deepEqual(stampTerminalEnv('/ws', {}), {
      GOCACHE: '/ws/.go-cache/build',
      GOMODCACHE: '/ws/.go-cache/mod',
      GOTELEMETRYDIR: '/ws/.go-cache/telemetry',
    })
  })
})

test('patchSubprocessTerminals stamps PTY spawns and restores on dispose', () => {
  const calls = []
  // Class-based like the real service: spawnTerminal lives on the prototype.
  class FakeSubprocess {
    spawnTerminal(spec) {
      calls.push(spec)
      return `handle:${spec.env.GOCACHE}`
    }
  }
  const sub = new FakeSubprocess()
  const ctx = { subprocess: sub }
  const dispose = withEnv('DSH_WORKSPACE_ENV_TOOLS', 'go', () => patchSubprocessTerminals(ctx))
  const handle = ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], cwd: '/proj', env: { TERM: 'dumb' } })
  assert.equal(handle, 'handle:/proj/.go-cache/build')
  assert.equal(calls[0].env.TERM, 'dumb')
  assert.equal(calls[0].env.GOCACHE, '/proj/.go-cache/build')
  // A spawn without cwd is passed through untouched.
  ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], env: {} })
  assert.equal('cwd' in calls[1], false)
  // Disposal restores the original method (a prototype method: no own prop).
  dispose()
  assert.equal(Object.prototype.hasOwnProperty.call(sub, 'spawnTerminal'), false)
  // After disposal the original method no longer stamps.
  assert.equal(
    withEnv('DSH_WORKSPACE_ENV_TOOLS', 'go', () => ctx.subprocess.spawnTerminal({ argv: [], cwd: '/x', env: {} })),
    'handle:undefined',
  )
})

test('patchSubprocessTerminals is a no-op without a subprocess service', () => {
  assert.equal(patchSubprocessTerminals({}), undefined)
})
