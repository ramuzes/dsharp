// tests/commands.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, guardDecision, translateGuardError, HELP_TEXT } from '../lib/commands.js'

test('parseCommand recognizes /ws use demo', () => {
  assert.deepEqual(parseCommand('/ws use demo'), { name: 'ws', sub: 'use', args: ['demo'] })
})

test('parseCommand recognizes bare /status /stop /help', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', sub: undefined, args: [] })
  assert.deepEqual(parseCommand('/stop'), { name: 'stop', sub: undefined, args: [] })
  assert.deepEqual(parseCommand('/help'), { name: 'help', sub: undefined, args: [] })
})

test('plain text and unknown commands are not commands', () => {
  assert.equal(parseCommand('fix the bug'), null)
  assert.equal(parseCommand('/unknown x'), null)
})

test('custom prefix is honored', () => {
  assert.deepEqual(parseCommand('!model deepseek', '!'), { name: 'model', sub: undefined, args: ['deepseek'] })
})

test('guardDecision blocks running sessions with guidance', () => {
  const d = guardDecision({ running: true })
  assert.equal(d.allowed, false)
  assert.match(d.reason, /\/stop/)
  assert.deepEqual(guardDecision({ running: false }), { allowed: true })
})

test('translateGuardError maps the typed RemoteError codes', () => {
  // RemoteError carries the namespaced code on `.code` (typert protocol).
  const held = Object.assign(new Error('owned by another host process'), { code: 'session/writer-held' })
  assert.match(translateGuardError(held), /正被另一个窗口\/进程占用/)
  assert.match(translateGuardError({ code: 'session/agent-busy' }), /运行中/)
  assert.match(translateGuardError({ rpcError: { code: 'session/agent-busy' } }), /运行中/)
  assert.match(translateGuardError({ code: 'session/not-found' }), /会话不存在/)
  assert.match(translateGuardError({ code: 'session/model-unavailable', message: 'glm-9 gone' }), /glm-9 gone/)
  assert.match(translateGuardError(new Error('boom')), /boom/)
})

test('HELP_TEXT lists every command', () => {
  for (const name of ['/ws', '/session', '/model', '/status', '/stop', '/help']) assert.match(HELP_TEXT, new RegExp(name))
})
