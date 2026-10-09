import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasMarkdown, chunkText, buildPostContent, stripMarkdown, formatAndSendText,
  buildStatusCard, buildQuestionCard, buildApprovalCard, renderChangesCard, renderDiffMessage,
} from '../lib/formatter.js'

test('hasMarkdown detects markdown hints', () => {
  assert.equal(hasMarkdown('plain text'), false)
  assert.equal(hasMarkdown('# Title'), true)
  assert.equal(hasMarkdown('a **bold** b'), true)
  assert.equal(hasMarkdown('- item'), true)
  assert.equal(hasMarkdown('```\ncode\n```'), true)
})

test('chunkText splits on line boundaries within the limit', () => {
  const text = Array.from({ length: 5 }, (_, i) => `line-${i}-`.repeat(30)).join('\n')
  const chunks = chunkText(text, 300)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 300)
  assert.equal(chunks.join('\n'), text)
})

test('chunkText hard-splits a single overlong line', () => {
  const chunks = chunkText('x'.repeat(300), 100)
  assert.deepEqual(chunks, ['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(100)])
})

test('buildPostContent wraps text in a zh_cn md tag', () => {
  const post = buildPostContent('# hi')
  assert.equal(post.zh_cn.content[0][0].tag, 'md')
  assert.equal(post.zh_cn.content[0][0].text, '# hi')
})

test('formatAndSendText: plain text goes out as text chunks', async () => {
  const sent = []
  const client = { sendText: async (c, t) => sent.push({ type: 'text', text: t }) }
  await formatAndSendText(client, 'oc_1', 'plain but long\n'.repeat(2000), { chunkLimit: 100 })
  assert.ok(sent.length > 1)
  assert.ok(sent.every(s => s.type === 'text'))
})

test('formatAndSendText: markdown post failure yields a single stripped text fallback', async () => {
  const sent = []
  const postCalls = []
  const client = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, msgType, content) => {
      postCalls.push(content)
      throw new Error('230025 content too large')
    },
  }
  const input = '# Title\nbody'
  await formatAndSendText(client, 'oc_1', input, { chunkLimit: 8000 })
  // Exactly one delivery per chunk: the stripped plain-text fallback, no post retry.
  assert.equal(sent.length, 1)
  assert.equal(postCalls.length, 1)
  assert.equal(sent[0].type, 'text')
  assert.equal(sent[0].text, stripMarkdown(input))
})

test('formatAndSendText: multi-chunk markdown delivers each chunk once with per-chunk fallback', async () => {
  const sent = []
  let failPost = true
  const client = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, msgType, content) => {
      if (failPost) { failPost = false; throw new Error('transient') }
      sent.push({ type: msgType, content })
    },
  }
  const input = '# A\n' + 'x'.repeat(80) + '\n# B\n' + 'y'.repeat(80)
  await formatAndSendText(client, 'oc_1', input, { chunkLimit: 100 })
  assert.ok(sent.length === 2) // 2 chunks, each delivered exactly once
  assert.equal(sent[0].type, 'text')       // chunk 1: post failed → stripped text
  assert.equal(sent[1].type, 'post')       // chunk 2: post succeeded
  assert.deepEqual(sent.map(s => s.type).filter(t => t === 'text').length, 1) // no duplicate text sends
})

test('buildStatusCard renders workspace/session/model with pending marker', () => {
  const card = buildStatusCard({ workspaceTitle: 'demo', workspacePath: '/tmp/demo', sessionTitle: 'fix bug', sessionId: 's1', model: 'deepseek-chat', modelPending: true, running: false })
  const elements = JSON.stringify(card)
  assert.match(elements, /demo/)
  assert.match(elements, /\/tmp\/demo/)
  assert.match(elements, /deepseek-chat/)
  assert.match(elements, /下一回合生效/)
})

test('buildQuestionCard carries choice button values', () => {
  const card = buildQuestionCard({ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }, 'act_1')
  const flat = JSON.stringify(card)
  assert.match(flat, /Proceed\?/)
  assert.match(flat, /"actionId":"act_1"/)
  assert.match(flat, /"choice":0/)
})

test('buildApprovalCard has four outcomes', () => {
  const flat = JSON.stringify(buildApprovalCard('run bash: rm -rf', 'act_2'))
  for (const label of ['允许一次', '本会话允许', '总是允许', '拒绝']) assert.match(flat, new RegExp(label))
})

test('renderChangesCard lists files with per-file diff buttons', () => {
  const card = renderChangesCard({ turn: 3, total: 12, added: 40, deleted: 2, files: [{ path: 'a.js', added: 30, deleted: 1 }, { path: 'b.md', added: 10, deleted: 1 }] }, () => 'act_x')
  const flat = JSON.stringify(card)
  assert.match(flat, /a\.js/)
  assert.match(flat, /b\.md/)
  assert.match(flat, /"kind":"diff"/)
})

test('renderDiffMessage wraps unified diff in a code block', () => {
  const msg = renderDiffMessage('a.js', '@@ -1 +1 @@\n-old\n+new')
  assert.match(JSON.stringify(msg), /```diff/)
})
