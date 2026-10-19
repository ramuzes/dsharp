import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServerArgs, resolveServerEntry, buildSpawn, CONNECTION_MODES, DEFAULT_CHANNEL } from '../lib/args.js'

test('auto mode: --auto-connect + --channel', () => {
  assert.deepEqual(buildServerArgs({ mode: 'auto', channel: 'stable' }),
    ['--no-usage-statistics', '--channel', 'stable', '--auto-connect'])
})

test('auto mode rejects endpoint', () => {
  assert.throws(() => buildServerArgs({ mode: 'auto', channel: 'stable', endpoint: 'http://x:1' }),
    /endpoint.*auto/i)
})

test('url mode: --browser-url with validated http endpoint', () => {
  assert.deepEqual(buildServerArgs({ mode: 'url', endpoint: 'http://127.0.0.1:9223' }),
    ['--no-usage-statistics', '--channel', 'stable', '--browser-url', 'http://127.0.0.1:9223'])
})

test('url mode requires an http(s) endpoint', () => {
  assert.throws(() => buildServerArgs({ mode: 'url' }), /endpoint.*required/i)
  assert.throws(() => buildServerArgs({ mode: 'url', endpoint: 'ws://x:1' }), /http/i)
  assert.throws(() => buildServerArgs({ mode: 'url', endpoint: 'http://a b' }), /whitespace|http/i)
})

test('ws mode: --ws-endpoint with validated ws(s) endpoint', () => {
  assert.deepEqual(buildServerArgs({ mode: 'ws', endpoint: 'ws://127.0.0.1:9223/devtools/browser/abc' }),
    ['--no-usage-statistics', '--channel', 'stable', '--ws-endpoint', 'ws://127.0.0.1:9223/devtools/browser/abc'])
  assert.throws(() => buildServerArgs({ mode: 'ws', endpoint: 'http://x:1' }), /ws/i)
})

test('unknown mode is rejected with the legal values', () => {
  assert.throws(() => buildServerArgs({ mode: 'launch' }), new RegExp(CONNECTION_MODES.join('|')))
})

test('channel is validated', () => {
  assert.throws(() => buildServerArgs({ mode: 'auto', channel: 'Bad Channel' }), /channel/i)
})

test('server entry is the MCP server bin, never the CLI bin', () => {
  const entry = resolveServerEntry()
  assert.ok(entry.endsWith('/build/src/bin/chrome-devtools-mcp.js'), entry)
  assert.ok(!entry.endsWith('/build/src/bin/chrome-devtools.js'), entry)
})

test('buildSpawn prepends node + entry', () => {
  const spawn = buildSpawn({ mode: 'auto', channel: 'stable' })
  assert.equal(spawn.command, process.execPath)
  assert.equal(spawn.args[0], resolveServerEntry())
  assert.deepEqual(spawn.args.slice(1), buildServerArgs({ mode: 'auto', channel: 'stable' }))
  assert.equal(DEFAULT_CHANNEL, 'stable')
})
