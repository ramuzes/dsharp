import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServerArgs, resolveEntry, buildSpawn, serverVersion, SERVERS, DEFAULT_SERVER, READ_ONLY_BY_SERVER, MODES_BY_SERVER } from '../lib/servers.js'

test('playwright url/ws map onto --cdp-endpoint', () => {
  assert.deepEqual(buildServerArgs('playwright', { mode: 'url', endpoint: 'http://127.0.0.1:9223' }),
    ['--cdp-endpoint', 'http://127.0.0.1:9223'])
  assert.deepEqual(buildServerArgs('playwright', { mode: 'ws', endpoint: 'ws://127.0.0.1:9223/devtools/browser/x' }),
    ['--cdp-endpoint', 'ws://127.0.0.1:9223/devtools/browser/x'])
})

test('playwright launch: headed chrome default, headless flag opt-in', () => {
  assert.deepEqual(buildServerArgs('playwright', { mode: 'launch' }), ['--browser', 'chrome'])
  assert.deepEqual(buildServerArgs('playwright', { mode: 'launch', headless: true, browser: 'chromium' }),
    ['--headless', '--browser', 'chromium'])
  assert.throws(() => buildServerArgs('playwright', { mode: 'launch', browser: 'Bad Browser' }), /browser/i)
})

test('playwright extension mode', () => {
  assert.deepEqual(buildServerArgs('playwright', { mode: 'extension' }), ['--extension'])
  assert.throws(() => buildServerArgs('playwright', { mode: 'extension', endpoint: 'http://x' }), /endpoint must not be set/i)
})

test('chrome-devtools modes keep their dialect', () => {
  assert.deepEqual(buildServerArgs('chrome-devtools', { mode: 'auto', channel: 'stable' }),
    ['--no-usage-statistics', '--channel', 'stable', '--auto-connect'])
  assert.deepEqual(buildServerArgs('chrome-devtools', { mode: 'url', endpoint: 'http://127.0.0.1:9223' }),
    ['--no-usage-statistics', '--browser-url', 'http://127.0.0.1:9223'])
  assert.deepEqual(buildServerArgs('chrome-devtools', { mode: 'ws', endpoint: 'ws://x/devtools/browser/y' }),
    ['--no-usage-statistics', '--ws-endpoint', 'ws://x/devtools/browser/y'])
})

test('mode/server legality is enforced with field-naming errors', () => {
  assert.throws(() => buildServerArgs('playwright', { mode: 'auto' }), /mode must be one of/i)
  assert.throws(() => buildServerArgs('chrome-devtools', { mode: 'extension' }), /mode must be one of/i)
  assert.throws(() => buildServerArgs('nope', { mode: 'url' }), /server must be one of/i)
  assert.throws(() => buildServerArgs('playwright', { mode: 'url' }), /endpoint is required/i)
  assert.throws(() => buildServerArgs('playwright', { mode: 'url', endpoint: 'http://a b' }), /whitespace/)
  assert.throws(() => buildServerArgs('chrome-devtools', { mode: 'url', endpoint: 'ws://x' }), /endpoint must be an http/i)
})

test('entries: playwright cli.js, chrome-devtools MCP server bin (never the CLI twin)', () => {
  assert.ok(resolveEntry('playwright').endsWith('/@playwright/mcp/cli.js'))
  const cdm = resolveEntry('chrome-devtools')
  assert.ok(cdm.endsWith('/build/src/bin/chrome-devtools-mcp.js'), cdm)
  assert.ok(!cdm.endsWith('/bin/chrome-devtools.js'))
})

test('server versions resolve beside entries', () => {
  assert.match(serverVersion('playwright'), /^0[.]0[.]\d+$/)
  assert.match(serverVersion('chrome-devtools'), /^\d+[.]\d+[.]\d+$/)
})

test('buildSpawn prepends node + entry', () => {
  const s = buildSpawn('playwright', { mode: 'launch' })
  assert.equal(s.command, process.execPath)
  assert.equal(s.args[0], resolveEntry('playwright'))
  assert.deepEqual(s.args.slice(1), buildServerArgs('playwright', { mode: 'launch' }))
  assert.deepEqual([...SERVERS], ['playwright', 'chrome-devtools'])
  assert.equal(DEFAULT_SERVER, 'playwright')
  assert.deepEqual([...MODES_BY_SERVER.playwright], ['launch', 'url', 'ws', 'extension'])
  assert.ok(READ_ONLY_BY_SERVER.playwright.includes('browser_snapshot'))
  assert.ok(READ_ONLY_BY_SERVER['chrome-devtools'].includes('list_pages'))
})
