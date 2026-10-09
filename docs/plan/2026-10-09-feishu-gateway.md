# feishu-gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 dsh host 插件 bundle，把飞书自建应用机器人的 p2p 消息接入 DSH（工作区/会话/模型切换 + 状态卡 + 提问/审批路由 + 改动预览）。

**Architecture:** 单 host 插件（ADR 0001），六模块：lark-client（官方 SDK 封装）、transport（长连接入站归一 + 去重）、formatter（降级链/分片/卡片）、router（chat↔workspace/session 绑定）、commands+guard（命令与切换守卫）、driver（会话编排 + 出站）、answerer（waterfall 应答者）。每 chat 单活动会话（ADR 0002），切换守卫复用 DSH 单写者语义。

**Tech Stack:** 纯 JS（ESM、零构建）、`@larksuiteoapi/node-sdk`（唯一运行时依赖，ADR 0003）、`@deepseek-ai/schemastery`（peer）、`node --test`。

**Spec:** `docs/specs/2026-10-09-feishu-gateway-design.md`

## Global Constraints

- 目录：`packages/feishu-gateway/`，bundle 布局照抄 `packages/airboard`（`package.json` + `cordis.patch.yml` + `index.js` + `lib/` + `tests/` + `README.md`）。
- 零构建、无 TypeScript；唯一运行时依赖 `@larksuiteoapi/node-sdk`；`@deepseek-ai/schemastery` 为 peer。
- 每消息分片上限默认 8000 字符（Config `messageChunkLimit`）；post/卡片请求体预算 30KB；超限必须分片而非截断。
- 出站 uuid 幂等参数必带；入站按 message_id 去重；卡片回调 action 按去重窗口防双击。
- waterfall 应答者必须 `next()` 委托不属于自己的请求；监听器注册为全局（非 scope）。
- 未配置 appId/appSecret 时插件 inactive，仅日志说明，不抛错。
- 所有测试 `node --test "tests/*.spec.js"`，不触真实飞书网络。
- 提交信息用 conventional commits（`feat:`/`test:`/`docs:`）。

## Review Focus

（每条含归属任务的钉死测试）

1. **post 30KB/被拒时的降级与分片**——发送器拒绝 post 后必须沿降级链走 text 并正确分片（Task 3 Step 1 测试 `chunkText` 与 `formatAndSend` 降级）。
2. **重复 message_id 与卡片双击**——飞书 at-least-once 重推与用户双击不得产生重复会话消息/重复决策（Task 2 Step 1 去重测试、Task 7 Step 1 action 去重测试）。
3. **`session/writer-held`/`agent-busy` 转译**——忙碌时切换必须变成友好提示而非异常泄漏（Task 5 Step 1 `translateGuardError` 测试）。
4. **非 feishu 来源会话的提问必须 `next()` 委托**——Web GUI 会话的提问被飞书拦截是最高危缺陷（Task 7 Step 1 路由测试）。
5. **超时（continued）问题的迟到答案走 `userQuestions.answer`**——直接回 waterfall 答案会丢失（Task 7 Step 1 late-answer 测试）。
6. **入站 content 是序列化 JSON 字符串**——`event.message.content` 必须 `JSON.parse`，直接当文本用会让每条消息带上引号（Task 2 Step 1 归一化测试）。

---

### Task 1: Bundle scaffold + Config + LarkClient（出站发送与排队）

**Files:**
- Create: `packages/feishu-gateway/package.json`
- Create: `packages/feishu-gateway/cordis.patch.yml`
- Create: `packages/feishu-gateway/lib/lark-client.js`
- Test: `packages/feishu-gateway/tests/lark-client.spec.js`

**Interfaces:**
- Consumes: `@larksuiteoapi/node-sdk` 的 `Client`（构造 `{appId, appSecret, domain}`；`client.im.v1.message.create({params:{receive_id_type},data:{receive_id,msg_type,content,uuid}})`、`client.im.v1.message.reply({path:{message_id},data:{content,msg_type,uuid}})`）。
- Produces:
  - `class LarkClient { constructor(options) ; async sendText(chatId, text, uuid?) ; async sendJson(chatId, msgType, contentObj, uuid?) ; async reply(messageId, msgType, contentObj, uuid?) }`，`options = { sdkClient, logger?, sendGapMs = 250 }`；
  - `export function readConfigString(value)`（Loader volatile 包装兼容读取）；
  - `export const Config`（schemastery schema：`appId`、`appSecret`（secret role）、`domain` 默认 `'https://open.feishu.cn'`、`commandPrefix` 默认 `'/'`、`messageChunkLimit` 默认 `8000`）。

- [ ] **Step 1: Write the failing test**

```js
// tests/lark-client.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { LarkClient } from '../lib/lark-client.js'

function fakeSdk() {
  const calls = []
  return {
    calls,
    im: { v1: { message: {
      async create(req) { calls.push({ op: 'create', req }); return { data: { message_id: `om_${calls.length}` } } },
      async reply(req) { calls.push({ op: 'reply', req }); return { data: { message_id: `om_r${calls.length}` } } },
    } } },
  }
}

test('sendText sends text msg with uuid and chat_id', async () => {
  const sdk = fakeSdk()
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await client.sendText('oc_1', 'hello', 'u1')
  const { op, req } = sdk.calls[0]
  assert.equal(op, 'create')
  assert.equal(req.params.receive_id_type, 'chat_id')
  assert.equal(req.data.receive_id, 'oc_1')
  assert.equal(req.data.msg_type, 'text')
  assert.deepEqual(JSON.parse(req.data.content), { text: 'hello' })
  assert.equal(req.data.uuid, 'u1')
})

test('sendJson serializes content object', async () => {
  const sdk = fakeSdk()
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await client.sendJson('oc_1', 'post', { zh_cn: { title: 't' } }, 'u2')
  assert.equal(sdk.calls[0].req.data.msg_type, 'post')
  assert.equal(JSON.parse(sdk.calls[0].req.data.content).zh_cn.title, 't')
})

test('sends to the same chat are serialized', async () => {
  const sdk = fakeSdk()
  const order = []
  let gate = Promise.resolve()
  sdk.im.v1.message.create = async req => {
    const prev = gate
    let release
    gate = new Promise(r => { release = r })
    await prev
    order.push(req.data.uuid)
    release()
    return { data: { message_id: 'om_x' } }
  }
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await Promise.all([client.sendText('oc_1', 'a', 'a'), client.sendText('oc_1', 'b', 'b')])
  assert.deepEqual(order, ['a', 'b'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/lark-client.spec.js`
Expected: FAIL（`Cannot find module '../lib/lark-client.js'`）

- [ ] **Step 3: Write minimal implementation**

```js
// package.json
{
  "name": "dsh-feishu-gateway",
  "version": "0.1.0",
  "description": "Feishu (Lark) bot gateway for dsh: p2p messages drive bound workspace sessions; questions/approvals round-trip as interactive cards",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "lib", "cordis.patch.yml", "README.md"],
  "scripts": { "test": "node --test \"tests/*.spec.js\"" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "@larksuiteoapi/node-sdk": "^1.44.0" },
  "peerDependencies": { "@deepseek-ai/schemastery": "*", "@deepseek-ai/dsh-storage-domain": "*" },
  "devDependencies": { "@deepseek-ai/schemastery": "*" }
}
```

```yaml
# cordis.patch.yml
# dsh-feishu-gateway bundle layer: one row mounting the Feishu gateway.
# Credentials default from the environment; values saved through the Plugins
# page land in a later layer and win.
- insert:
    - id: feishu-gateway
      name: dsh-feishu-gateway
      config:
        appId: !!js "process.env.FEISHU_APP_ID ?? ''"
        appSecret: !!js "process.env.FEISHU_APP_SECRET ?? ''"
        domain: !!js "process.env.FEISHU_DOMAIN ?? 'https://open.feishu.cn'"
```

```js
// lib/lark-client.js
/**
 * Outbound Feishu messaging over the official SDK client, serialized per chat
 * (Feishu caps one bot at 5 QPS to the same chat) and always carrying the
 * optional uuid idempotency parameter.
 */

/** Read a Config field the Loader may hand as a volatile wrapper or plain value. */
export function readConfigString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

export class LarkClient {
  /** @param {{ sdkClient: any, logger?: any, sendGapMs?: number }} options */
  constructor({ sdkClient, logger, sendGapMs = 250 }) {
    this.sdk = sdkClient
    this.logger = logger
    this.sendGapMs = sendGapMs
    /** @type {Map<string, Promise<void>>} per-chat send chains */
    this.queues = new Map()
  }

  /** Run one send serialized per chat, with a small gap between sends. */
  enqueue(chatId, run) {
    const prev = this.queues.get(chatId) ?? Promise.resolve()
    const next = prev.then(run, run)
    const drained = next.then(
      () => { if (this.queues.get(chatId) === next_slot) this.queues.delete(chatId) },
      () => {},
    )
    const next_slot = next
    this.queues.set(chatId, drained)
    return next
  }

  async create(chatId, msgType, contentObj, uuid) {
    await this.enqueue(chatId, async () => {
      if (this.sendGapMs > 0) await new Promise(r => setTimeout(r, this.sendGapMs))
      await this.sdk.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(contentObj), ...(uuid ? { uuid } : {}) },
      })
    })
  }

  /** Send a plain text message. */
  async sendText(chatId, text, uuid) { return this.create(chatId, 'text', { text }, uuid) }

  /** Send a msg_type with a JSON content object (post / interactive / …). */
  async sendJson(chatId, msgType, contentObj, uuid) { return this.create(chatId, msgType, contentObj, uuid) }

  /** Reply to one message id. */
  async reply(messageId, msgType, contentObj, uuid) {
    await this.enqueue(`reply:${messageId}`, async () => {
      if (this.sendGapMs > 0) await new Promise(r => setTimeout(r, this.sendGapMs))
      await this.sdk.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: msgType, content: JSON.stringify(contentObj), ...(uuid ? { uuid } : {}) },
      })
    })
  }
}
```

```js
// lib/config.js
import Schema from '@deepseek-ai/schemastery'

/** Row configuration for the feishu-gateway Loader entry. */
export const Config = Schema.object({
  appId: Schema.string().default('').volatile(),
  appSecret: Schema.string().role('secret').default('').volatile(),
  domain: Schema.string().default('https://open.feishu.cn').volatile(),
  commandPrefix: Schema.string().default('/').volatile(),
  messageChunkLimit: Schema.number().default(8000).volatile(),
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/lark-client.spec.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): bundle scaffold, Config schema, LarkClient outbound queue"
```

---

### Task 2: Transport — 长连接事件归一化、去重、回调路由

**Files:**
- Create: `packages/feishu-gateway/lib/transport.js`
- Test: `packages/feishu-gateway/tests/transport.spec.js`

**Interfaces:**
- Consumes: 官方 SDK `WSClient`（构造 `{appId, appSecret, domain, loggerLevel}`；`start({eventDispatcher})`，`EventDispatcher({}).register({ 'im.message.receive_v1': async data => …, 'card.action.trigger': async data => … })`）；Task 1 无依赖。
- Produces:
  - `normalizeInboundEvent(eventName, data)` → `{ kind: 'message', chatId, messageId, senderOpenId, text } | { kind: 'card-action', actionId, value, messageId, chatId, operatorOpenId } | null`（不认识的事件返回 null）；
  - `class MessageDedup { constructor({ ttlMs = 86_400_000 } = {}) ; seen(id) → boolean（记录并返回是否已见） ; prune() }`；
  - `class ActionDedup { constructor({ windowMs = 15 * 60_000 } = {}) ; take(actionId) → boolean（窗口内首次 true） }`；
  - `startGatewayTransport({ config, handlers, logger, wsClientFactory })` → `Promise<() => void>`（返回 disposer；`handlers = { onMessage(normalized), onCardAction(normalized) }`）。

- [ ] **Step 1: Write the failing test**

```js
// tests/transport.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInboundEvent, MessageDedup, ActionDedup } from '../lib/transport.js'

const messageEvent = {
  event: {
    sender: { sender_id: { open_id: 'ou_alice' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi there' }) },
  },
}

test('normalizes im.message.receive_v1, parsing content JSON', () => {
  const n = normalizeInboundEvent('im.message.receive_v1', messageEvent)
  assert.deepEqual(n, { kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_alice', text: 'hi there' })
})

test('non-text message types normalize with placeholder text', () => {
  const ev = { event: { sender: { sender_id: { open_id: 'ou_a' } }, message: { message_id: 'om_2', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'k' }) } } }
  const n = normalizeInboundEvent('im.message.receive_v1', ev)
  assert.equal(n.kind, 'message')
  assert.match(n.text, /\[Unsupported message type: image\]/)
})

test('unknown events and group chats normalize to null', () => {
  assert.equal(normalizeInboundEvent('contact.user.updated_v3', {}), null)
  const group = { event: { ...messageEvent.event, message: { ...messageEvent.event.message, chat_type: 'group' } } }
  assert.equal(normalizeInboundEvent('im.message.receive_v1', group), null)
})

test('card.action.trigger normalizes with actionId and value', () => {
  const data = { event: { operator: { open_id: 'ou_a' }, action: { value: { qid: 'q1', choice: 0 }, tag: 'button' }, context: { open_message_id: 'om_c', open_chat_id: 'oc_1' } } }
  const n = normalizeInboundEvent('card.action.trigger', data)
  assert.deepEqual(n, { kind: 'card-action', actionId: 'q1', value: { qid: 'q1', choice: 0 }, messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a' })
})

test('MessageDedup: same message_id seen twice reports duplicate', () => {
  const d = new MessageDedup({ ttlMs: 60_000 })
  assert.equal(d.seen('om_1'), false)
  assert.equal(d.seen('om_1'), true)
})

test('ActionDedup: double click inside window is dropped', () => {
  const d = new ActionDedup({ windowMs: 60_000 })
  assert.equal(d.take('a1'), true)
  assert.equal(d.take('a1'), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/transport.spec.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// lib/transport.js
/**
 * Inbound Feishu long-connection transport: normalize SDK event payloads to
 * gateway shapes, deduplicate at-least-once redeliveries (message_id) and
 * card double-clicks, and dispatch to handlers.
 */

/**
 * Normalize one SDK event into a gateway shape, or null when the gateway does
 * not handle it (unknown event type, non-p2p chat — v1 is p2p only).
 */
export function normalizeInboundEvent(eventName, data) {
  if (eventName === 'im.message.receive_v1') {
    const message = data?.event?.message
    if (message?.chat_type !== 'p2p') return null
    let content = {}
    try { content = JSON.parse(message.content ?? '{}') } catch { content = {} }
    const text = message.message_type === 'text'
      ? String(content.text ?? '')
      : `[Unsupported message type: ${message.message_type}]`
    return {
      kind: 'message',
      chatId: String(message.chat_id ?? ''),
      messageId: String(message.message_id ?? ''),
      senderOpenId: String(data.event.sender?.sender_id?.open_id ?? ''),
      text,
    }
  }
  if (eventName === 'card.action.trigger') {
    const event = data?.event ?? {}
    const value = event.action?.value
    const actionId = typeof value === 'object' && value !== null ? String(value.actionId ?? '') : ''
    if (actionId === '') return null
    return {
      kind: 'card-action',
      actionId,
      value,
      messageId: String(event.context?.open_message_id ?? ''),
      chatId: String(event.context?.open_chat_id ?? ''),
      operatorOpenId: String(event.operator?.open_id ?? ''),
    }
  }
  return null
}

/** message_id deduplication with TTL (official guidance: dedupe on message_id). */
export class MessageDedup {
  /** @param {{ ttlMs?: number }} [options] */
  constructor({ ttlMs = 86_400_000 } = {}) {
    this.ttlMs = ttlMs
    /** @type {Map<string, number>} */
    this.at = new Map()
  }

  /** Record id; true when it was already recorded (a duplicate). */
  seen(id) {
    const now = Date.now()
    this.prune(now)
    if (this.at.has(id)) return true
    this.at.set(id, now)
    return false
  }

  prune(now = Date.now()) {
    for (const [id, at] of this.at) {
      if (now - at > this.ttlMs) this.at.delete(id)
    }
  }
}

/** Card-action dedup window against double clicks. */
export class ActionDedup {
  /** @param {{ windowMs?: number }} [options] */
  constructor({ windowMs = 15 * 60_000 } = {}) {
    this.windowMs = windowMs
    /** @type {Map<string, number>} */
    this.at = new Map()
  }

  /** true when this actionId may proceed (first press inside the window). */
  take(actionId) {
    const now = Date.now()
    const prev = this.at.get(actionId)
    if (prev !== undefined && now - prev < this.windowMs) return false
    this.at.set(actionId, now)
    return true
  }
}

/**
 * Start the SDK WebSocket long connection and dispatch normalized events.
 * Returns a disposer that stops the client (best effort — the SDK exposes no
 * stop(); we drop handlers so late frames are ignored).
 *
 * @param {{ config: { appId: string, appSecret: string, domain: string }, handlers: { onMessage: (n: any) => Promise<void> | void, onCardAction: (n: any) => Promise<void> | void }, logger?: any, wsClientFactory?: (config: any, dispatcher: any) => Promise<() => void> }} args
 * @returns {Promise<() => void>}
 */
export async function startGatewayTransport({ config, handlers, logger, wsClientFactory }) {
  const messages = new MessageDedup()
  const actions = new ActionDedup()
  let live = true

  const dispatcherHandlers = {
    'im.message.receive_v1': async data => {
      const n = normalizeInboundEvent('im.message.receive_v1', data)
      if (n === null || !live) return
      if (messages.seen(n.messageId)) return
      try { await handlers.onMessage(n) } catch (error) { logger?.warn?.(`feishu-gateway: message handler failed: ${String(error)}`) }
    },
    'card.action.trigger': async data => {
      const n = normalizeInboundEvent('card.action.trigger', data)
      if (n === null || !live) return
      if (!actions.take(n.actionId)) return
      try { await handlers.onCardAction(n) } catch (error) { logger?.warn?.(`feishu-gateway: card action handler failed: ${String(error)}`) }
    },
  }

  const start = wsClientFactory ?? defaultWsClientFactory
  const stop = await start(config, dispatcherHandlers)
  return () => { live = false; stop?.() }
}

/**
 * Default factory using the official SDK. Import is dynamic so tests never
 * load the SDK; the dispatcher shape is `EventDispatcher({}).register(map)`.
 */
async function defaultWsClientFactory(config, dispatcherHandlers) {
  const Lark = await import('@larksuiteoapi/node-sdk')
  const wsClient = new Lark.WSClient({ appId: config.appId, appSecret: config.appSecret, domain: config.domain, loggerLevel: Lark.LoggerLevel.info })
  await wsClient.start({ eventDispatcher: new Lark.EventDispatcher({}).register(dispatcherHandlers) })
  return () => {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/transport.spec.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): inbound transport normalization, dedup, card-action routing"
```

---

### Task 3: Formatter — 降级链、分片、diff 渲染、卡片构建

**Files:**
- Create: `packages/feishu-gateway/lib/formatter.js`
- Test: `packages/feishu-gateway/tests/formatter.spec.js`

**Interfaces:**
- Consumes: Task 1 `LarkClient.sendText/sendJson`。
- Produces（全部纯函数或 (client) 注入）：
  - `hasMarkdown(text) → boolean`；
  - `chunkText(text, limit) → string[]`（按行边界优先、退化为硬切）；
  - `buildPostContent(text) → object`（post + `md` tag，zh_cn）；
  - `stripMarkdown(text) → string`；
  - `async formatAndSendText(client, chatId, text, { chunkLimit = 8000 })`（降级链：无 md→text 分片；有 md→每片 post(md)→该片失败（throw）则该片转 stripMarkdown text 重发）；
  - `renderChangesCard(summary) → object`（interactive JSON 1.0：改动文件列表 + 每文件增删行；按钮 value 带 `{actionId, kind:'diff', path}`——actionId 由调用者注入 `makeActionId`）；
  - `renderDiffMessage(path, diff) → object`（post：md 代码块）；
  - `buildStatusCard(state) → object`（`state = { workspaceTitle, workspacePath, sessionTitle, sessionId, model, modelPending, running }`）；
  - `buildQuestionCard(question, actionId) → object`（选项按钮，value `{actionId, kind:'answer', questionId, choice}`；multi_select 提示回复文本）；
  - `buildApprovalCard(prompt, actionId) → object`（Allow Once/Session/Always/Deny）。

- [ ] **Step 1: Write the failing test**

```js
// tests/formatter.spec.js
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
  const chunks = chunkText(text, 200)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 200)
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

test('formatAndSendText: markdown prefers post, falls back to stripped text per chunk', async () => {
  const sent = []
  let failPost = true
  const client = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, msgType, content) => {
      if (failPost) { failPost = false; throw new Error('230025 content too large') }
      sent.push({ type: msgType, content })
    },
  }
  await formatAndSendText(client, 'oc_1', '# Title\nbody', { chunkLimit: 8000 })
  assert.equal(sent.length, 2)
  assert.equal(sent[0].type, 'text')
  assert.equal(sent[0].text, 'Title\nbody')  // heading marker stripped
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/formatter.spec.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// lib/formatter.js
/**
 * Outbound formatting: the fallback chain (markdown → post `md` tag → stripped
 * text), size-aware chunking, and the v1 card builders (interactive JSON 1.0).
 */

const MD_HINT = /(^|\n)#{1,6} |\*\*|`{1,3}|(^|\n)[-*>+] |(\[.+\]\(.+\))|(^|\n)\|/

/** True when the text carries markdown the post `md` tag can render. */
export function hasMarkdown(text) { return MD_HINT.test(text) }

/** Strip common markdown to plain text (the last-resort fallback). */
export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?|```/g, ''))
    .replace(/(^|\n)#{1,6} /g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\n)[-*>+] /g, '$1')
}

/**
 * Split text into chunks no longer than limit, preferring line boundaries and
 * falling back to a hard split for a single overlong line. join('\n') of the
 * chunks is not guaranteed byte-identical to the input when hard splits occur,
 * so prefer line boundaries: they apply whenever any newline exists in range.
 */
export function chunkText(text, limit) {
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Wrap markdown in a zh_cn post payload using the `md` tag. */
export function buildPostContent(text) {
  return { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } }
}

/**
 * Send text through the fallback chain: markdown chunks go post(md)-first and
 * fall back to stripped plain text per chunk when the post send is rejected.
 * @param {{ sendText: Function, sendJson: Function }} client
 */
export async function formatAndSendText(client, chatId, text, { chunkLimit = 8000 } = {}) {
  const md = hasMarkdown(text)
  const chunks = chunkText(text, chunkLimit)
  for (const chunk of chunks) {
    if (md) {
      try { await client.sendJson(chatId, 'post', buildPostContent(chunk)); continue }
      catch { /* fall through to stripped text */ }
      await client.sendText(chatId, stripMarkdown(chunk))
    } else {
      await client.sendText(chatId, chunk)
    }
  }
}

// --- interactive card JSON 1.0 helpers ---

function mdElement(markdown) { return { tag: 'div', text: { tag: 'lark_md', content: markdown } } }

function button(text, value, style = 'default') {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: style, value }
}

function card(headerTitle, elements) {
  return { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: headerTitle }, template: 'blue' }, elements }
}

/** Current-binding status card. */
export function buildStatusCard(state) {
  const lines = [
    `**工作区**：${state.workspaceTitle}（\`${state.workspacePath}\`）`,
    `**会话**：${state.sessionTitle}（\`${state.sessionId}\`）`,
    `**模型**：${state.model}${state.modelPending ? '（下一回合生效）' : ''}`,
    `**状态**：${state.running ? '运行中 🟢' : '空闲 ⚪'}`,
  ]
  return card('dsh 当前状态', [mdElement(lines.join('\n'))])
}

/** Structured-question card: one button per option. */
export function buildQuestionCard(question, actionId) {
  const elements = [mdElement(question.question)]
  const buttons = (question.options ?? []).map((opt, i) =>
    button(opt.label, { actionId, kind: 'answer', questionId: question.id, choice: i }))
  elements.push({ tag: 'action', actions: buttons })
  if (question.multi_select) {
    elements.push(mdElement('（多选：请直接回复文字，如 `1,2`）'))
  }
  return card(question.header ?? '需要你的决策', elements)
}

/** Permission-approval card aligned with DSH ApprovalOutcome semantics. */
export function buildApprovalCard(prompt, actionId) {
  const outcomes = [
    ['允许一次', 'allow-once', 'primary'],
    ['本会话允许', 'allow-session', 'default'],
    ['总是允许', 'allow-always', 'default'],
    ['拒绝', 'deny', 'danger'],
  ]
  return card('权限请求', [
    mdElement(prompt),
    { tag: 'action', actions: outcomes.map(([label, outcome, style]) => button(label, { actionId, kind: 'approval', outcome }, style)) },
  ])
}

/** End-of-turn workspace changes summary with per-file diff buttons. */
export function renderChangesCard(summary, makeActionId) {
  const fileLines = (summary.files ?? []).map(f =>
    `\`${f.path}\` +${f.added ?? 0} / -${f.deleted ?? 0}`)
  const elements = [
    mdElement([`第 ${summary.turn} 回合改动：${summary.files?.length ?? 0} 个文件，+${summary.added ?? 0} / -${summary.deleted ?? 0}`,
      ...fileLines].join('\n')),
    { tag: 'action', actions: (summary.files ?? []).map(f =>
      button(`diff ${f.path}`, { actionId: makeActionId(f.path), kind: 'diff', path: f.path })) },
    { tag: 'hr' },
  ]
  return card('改动摘要', elements)
}

/** One file's unified diff as a post message with a fenced code block. */
export function renderDiffMessage(path, diff) {
  return buildPostContent(`**${path}**\n\`\`\`diff\n${diff}\n\`\`\``)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/formatter.spec.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): fallback chain, chunking, diff and card builders"
```

---

### Task 4: Router — chat↔workspace/session 绑定存储

**Files:**
- Create: `packages/feishu-gateway/lib/router.js`
- Test: `packages/feishu-gateway/tests/router.spec.js`

**Interfaces:**
- Consumes: 无（持久化注入）。
- Produces:
  - `class BindingRouter { constructor(options) ; async load() ; async get(chatId) → Binding | undefined ; async bind(chatId, { workspaceId, workspaceTitle, workspacePath }) ; async setActive(chatId, sessionId, sessionTitle)（旧活动会话入 history 头部，去重，上限 10） ; async history(chatId) → SessionHistoryEntry[] }`；
  - `Binding = { chatId, workspaceId, workspaceTitle, workspacePath, activeSessionId?, activeSessionTitle?, sessionHistory: [{ sessionId, title }], updatedAt }`；
  - `options = { persist?: { load(): Promise<any>, save(state): Promise<void> } }`（缺省用内存 Map，生产由 apply 注入 storage-domain 持久化）。

- [ ] **Step 1: Write the failing test**

```js
// tests/router.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { BindingRouter } from '../lib/router.js'

function memoryPersist() {
  let state = undefined
  return { load: async () => state, save: async s => { state = s } }
}

test('bind then setActive round-trips through persistence', async () => {
  const persist = memoryPersist()
  const router = new BindingRouter({ persist })
  await router.load()
  await router.bind('oc_1', { workspaceId: 'w1', workspaceTitle: 'demo', workspacePath: '/tmp/demo' })
  await router.setActive('oc_1', 's1', 'first session')
  const router2 = new BindingRouter({ persist })
  await router2.load()
  const b = await router2.get('oc_1')
  assert.equal(b.activeSessionId, 's1')
  assert.equal(b.workspaceTitle, 'demo')
})

test('setActive pushes the previous session into history (deduped, capped)', async () => {
  const router = new BindingRouter({ persist: memoryPersist() })
  await router.load()
  await router.bind('oc_1', { workspaceId: 'w1', workspaceTitle: 't', workspacePath: 'p' })
  for (let i = 0; i < 12; i++) await router.setActive('oc_1', `s${i}`, `session ${i}`)
  const b = await router.get('oc_1')
  assert.equal(b.activeSessionId, 's11')
  assert.equal(b.sessionHistory.length, 10)
  assert.equal(b.sessionHistory[0].sessionId, 's10') // most recent first
  // switching back to s9 moves it out of history into active without dupes
  await router.setActive('oc_1', 's9', 'session 9')
  const b2 = await router.get('oc_1')
  assert.equal(b2.activeSessionId, 's9')
  assert.ok(!b2.sessionHistory.some(e => e.sessionId === 's9'))
})

test('get on unknown chat is undefined', async () => {
  const router = new BindingRouter({ persist: memoryPersist() })
  await router.load()
  assert.equal(await router.get('oc_x'), undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/router.spec.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// lib/router.js
/**
 * The chat → workspace + active-session binding store (the SPEC's Binding).
 * Switching is pointer movement: the demoted session goes to the head of a
 * capped history so /session resume can offer it back.
 */

const HISTORY_LIMIT = 10

export class BindingRouter {
  /** @param {{ persist?: { load(): Promise<any>, save(state: any): Promise<void> } }} [options] */
  constructor({ persist } = {}) {
    this.persist = persist ?? {
      load: async () => undefined,
      save: async () => {},
    }
    /** @type {Map<string, any>} */
    this.bindings = new Map()
  }

  async load() {
    const state = await this.persist.load()
    if (Array.isArray(state)) {
      for (const b of state) if (b?.chatId) this.bindings.set(b.chatId, b)
    }
  }

  async save() {
    await this.persist.save([...this.bindings.values()])
  }

  /** The binding for one chat, or undefined. */
  async get(chatId) { return this.bindings.get(chatId) }

  /** Create or replace the workspace binding of one chat. */
  async bind(chatId, { workspaceId, workspaceTitle, workspacePath }) {
    const existing = this.bindings.get(chatId)
    this.bindings.set(chatId, {
      chatId,
      workspaceId,
      workspaceTitle,
      workspacePath,
      activeSessionId: undefined,
      activeSessionTitle: undefined,
      sessionHistory: existing?.sessionHistory ?? [],
      updatedAt: Date.now(),
    })
    await this.save()
  }

  /** Point the chat's Active Session at sessionId; demote the old one into history. */
  async setActive(chatId, sessionId, sessionTitle) {
    const binding = this.bindings.get(chatId)
    if (binding === undefined) throw new Error(`no binding for chat ${chatId}`)
    const history = binding.sessionHistory.filter(e => e.sessionId !== sessionId)
    if (binding.activeSessionId !== undefined && binding.activeSessionId !== sessionId) {
      history.unshift({ sessionId: binding.activeSessionId, title: binding.activeSessionTitle ?? binding.activeSessionId })
    }
    binding.activeSessionId = sessionId
    binding.activeSessionTitle = sessionTitle
    binding.sessionHistory = history.slice(0, HISTORY_LIMIT)
    binding.updatedAt = Date.now()
    await this.save()
  }

  /** Session history for /session resume, most recent first. */
  async history(chatId) { return this.bindings.get(chatId)?.sessionHistory ?? [] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/router.spec.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): binding router with pointer-switch session history"
```

---

### Task 5: Commands + 切换守卫

**Files:**
- Create: `packages/feishu-gateway/lib/commands.js`
- Test: `packages/feishu-gateway/tests/commands.spec.js`

**Interfaces:**
- Consumes: Task 4 `BindingRouter`（类型引用）；无运行时依赖。
- Produces:
  - `parseCommand(text, prefix = '/') → { name, sub, args } | null`（`name ∈ {ws, session, model, status, stop, help}`；非命令 null）；
  - `guardDecision({ running }) → { allowed: boolean, reason?: string }`（`running === true` → `{ allowed: false, reason: '会话运行中…' }`）；
  - `translateGuardError(error) → string`（`writer-held`/`agent-busy` → 友好中文；其余透传 message）；
  - `HELP_TEXT`（常量，命令一览）。

- [ ] **Step 1: Write the failing test**

```js
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
  assert.deepEqual(parseCommand('!model deepseek'), { name: 'model', sub: undefined, args: ['deepseek'] })
})

test('guardDecision blocks running sessions with guidance', () => {
  const d = guardDecision({ running: true })
  assert.equal(d.allowed, false)
  assert.match(d.reason, /\/stop/)
  assert.deepEqual(guardDecision({ running: false }), { allowed: true })
})

test('translateGuardError maps writer-held and agent-busy', () => {
  assert.match(translateGuardError(new Error('rpc session/writer-held')), /运行中/)
  assert.match(translateGuardError({ rpcError: { code: 'session/agent-busy' } }), /运行中/)
  assert.match(translateGuardError(new Error('boom')), /boom/)
})

test('HELP_TEXT lists every command', () => {
  for (const name of ['/ws', '/session', '/model', '/status', '/stop', '/help']) assert.match(HELP_TEXT, new RegExp(name))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/commands.spec.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// lib/commands.js
/**
 * Slash-command parsing and the Switch Guard decision/translation helpers.
 * Pure logic: execution lives in the driver.
 */

const COMMANDS = new Set(['ws', 'session', 'model', 'status', 'stop', 'help'])

/**
 * Parse one inbound text as a gateway command.
 * @returns {{ name: string, sub: string | undefined, args: string[] } | null}
 */
export function parseCommand(text, prefix = '/') {
  if (typeof text !== 'string' || !text.startsWith(prefix)) return null
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean)
  const [name, sub, ...args] = parts
  if (name === undefined || !COMMANDS.has(name)) return null
  return { name, sub, args }
}

/** Switch Guard: mutations require the target session to be idle. */
export function guardDecision({ running }) {
  if (running === true) {
    return { allowed: false, reason: '会话运行中：请先 /stop 打断当前回合，或等它完成后再切换。' }
  }
  return { allowed: true }
}

/** Map DSH single-writer errors to a friendly chat message. */
export function translateGuardError(error) {
  const text = `${error?.rpcError?.code ?? ''} ${error?.message ?? String(error)}`
  if (text.includes('writer-held') || text.includes('agent-busy')) {
    return '会话正被占用（可能在运行中）：请先 /stop 或稍后重试。'
  }
  return error?.message ?? String(error)
}

export const HELP_TEXT = [
  '/ws list — 列出所有工作区',
  '/ws use <名称> — 切换绑定的工作区',
  '/ws new <路径> [标题] — 注册新工作区并绑定',
  '/session new — 在当前工作区开新会话',
  '/session resume — 从会话历史中恢复',
  '/stop — 打断当前回合',
  '/model — 查看或选择模型',
  '/status — 显示当前状态卡',
  '/help — 本帮助',
].join('\n')
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/commands.spec.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): command parser, switch guard, error translation"
```

---

### Task 6: Driver — 会话编排与出站转发

**Files:**
- Create: `packages/feishu-gateway/lib/driver.js`
- Test: `packages/feishu-gateway/tests/driver.spec.js`

**Interfaces:**
- Consumes: Task 1 `LarkClient`、Task 3 `formatAndSendText/buildStatusCard/renderChangesCard/renderDiffMessage`、Task 4 `BindingRouter`、Task 5 `parseCommand/guardDecision/translateGuardError/HELP_TEXT`。
- Produces:
  - `class GatewayDriver { constructor({ ctx, lark, router, config, logger, makeActionId }) ; async handleInbound(normalized) ; async handleCardAction(normalized) ; async onSessionEvent(session, event) }`；
  - driver 依赖注入的 host 服务面（fake 供测试）：`ctx.agents`（`get(id)`、`create(options)` → `{ agent }`、`resume({ resumeSessionId })`）、`ctx.workspaceRegistry`（`list()`、`create(path, title)`、`resolveByPath(path)`、`attachSession(workspaceId, sessionId)`）、`ctx.workspaceChanges`（`summary(sessionId, seq)`、`diff(sessionId, seq, index)`）、agent 句柄带 `followup(text, source)`、`steer(text, source)`、`status`、`session`（`id`、`header.cwd`、`title()`、`lastAssistantText()`——测试 fake 按 webhook/agent 语义实现）。

  实现要点（写进代码注释）：
  - `handleInbound`：命令分发——`/help`→HELP_TEXT；`/status`→状态卡；`/ws list`→工作区列表；`/ws use`→指针切换（不过守卫）+ 状态卡；`/ws new`→守卫 → `workspaceRegistry.create` + `router.bind` + 开新会话；`/session new`、`/session resume`（无参列历史卡，选择走 card-action kind:'resume'）→守卫；`/model`（无参列目录卡，选择走 kind:'model'）→守卫 → `ctx.apiSessions.selectModel`；`/stop`→interrupt 活动会话。非命令文本：无绑定→引导卡；有绑定→无 activeSession 则建会话（cwd=workspacePath、source kind 'feishu'），否则 `resume`+`followup`。
  - `onSessionEvent`：仅处理来源为 feishu 且 sessionId 等于某绑定 activeSessionId 的会话；`turn/end` → 取 lastAssistantText 走 `formatAndSendText`，随后查 `workspaceChanges.summary` 发 `renderChangesCard`；`model/selection` 等忽略。
  - `handleCardAction`：kind 'diff' → `workspaceChanges.diff` → `renderDiffMessage`；kind 'resume' → 守卫后 setActive+resume；kind 'model' → selectModel；其余交给 answerer（通过构造注入 `answererCallback`，见 Task 7 接线）。

- [ ] **Step 1: Write the failing test**

```js
// tests/driver.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayDriver } from '../lib/driver.js'
import { BindingRouter } from '../lib/router.js'

/** Minimal fake of the host surface the driver consumes. */
function makeCtx() {
  const agents = new Map()
  const workspaces = [
    { id: 'w1', title: 'demo', path: '/tmp/demo' },
    { id: 'w2', title: 'site', path: '/tmp/site' },
  ]
  const sent = []
  let seq = 0
  const ctx = {
    sent,
    agents: {
      get: id => agents.get(id),
      create: async opts => {
        const agent = makeAgent(opts)
        agents.set(agent.session.id, agent)
        return { agent }
      },
      resume: async ({ resumeSessionId }) => {
        const agent = agents.get(resumeSessionId) ?? makeAgent({ sessionId: resumeSessionId, meta: { cwd: '/tmp/demo' } })
        agents.set(agent.session.id, agent)
        return { agent }
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      create: async (path, title) => {
        const w = { id: `w${workspaces.length + 1}`, title: title ?? path, path }
        workspaces.push(w)
        return w
      },
      resolveByPath: async path => workspaces.find(w => w.path === path),
      attachSession: () => {},
    },
    workspaceChanges: {
      summary: (sessionId) => ({ turn: 1, total: 3, added: 5, deleted: 1, files: [{ path: 'a.js', added: 4, deleted: 1 }] }),
      diff: async () => '@@ -1 +1 @@\n-old\n+new',
    },
    apiSessions: { selectModel: async () => {} },
    llm: { listModels: async () => [{ provider: 'deepseek', models: [{ id: 'deepseek-chat' }] }] },
  }
  function makeAgent(opts) {
    const id = opts.sessionId ?? `s${++seq}`
    return {
      status: 'idle',
      session: { id, header: { cwd: opts.meta?.cwd ?? '/tmp/demo' }, title: () => `session ${id}`, lastAssistantText: () => `done: ${id}` },
      followuped: [],
      followup(text, source) { this.followuped.push({ text, source }); this.status = 'running'; this.lastUserSource = source },
      steer(text) { this.steered = text },
      interrupt() { this.status = 'idle' },
    }
  }
  return ctx
}

function makeDriver(ctx) {
  const sent = []
  const lark = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, mt, content) => sent.push({ type: mt, content }),
  }
  const router = new BindingRouter()
  const driver = new GatewayDriver({
    ctx, lark, router,
    config: { commandPrefix: '/', messageChunkLimit: 8000 },
    logger: console,
    makeActionId: () => `act_${sent.length}`,
  })
  driver.sent = sent
  return { driver, sent, router }
}

test('plain message with no binding asks the user to bind a workspace', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: 'do something' })
  assert.match(JSON.stringify(sent), /\/ws/)
})

test('message after /ws use flows into a new session then resume+followup', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  const card = sent.find(s => s.type === 'interactive')
  assert.ok(card, 'status card sent')
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix the bug' })
  const first = [...ctx.agents._nope ?? []]
  // the first task message created a session in /tmp/demo
  const binding = await driver.router.get('oc_1')
  assert.equal(binding.activeSessionId.startsWith('s'), true)
  assert.equal(binding.workspacePath, '/tmp/demo')
})

test('turn end sends assistant text then changes card', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  agent.lastUserSource = { kind: 'feishu', chatId: 'oc_1' }
  await driver.onSessionEvent(agent.session, { type: 'turn/end', seq: 1 })
  assert.ok(sent.some(s => s.type === 'text' && /done:/.test(s.text)), 'assistant text sent')
  assert.ok(sent.some(s => s.type === 'interactive' && /改动摘要/.test(JSON.stringify(s.content))), 'changes card sent')
})

test('switch guard blocks /session new while running', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).status = 'running'
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/session new' })
  assert.match(JSON.stringify(sent), /\/stop/)
})

test('diff card action returns the file diff', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'card-action', actionId: 'a', value: { actionId: 'a', kind: 'diff', path: 'a.js' }, messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a' })
  assert.ok(sent.some(s => s.type === 'post' && /diff/.test(JSON.stringify(s.content))))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/driver.spec.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// lib/driver.js
/**
 * Session orchestration: inbound messages and card actions in, assistant
 * output and previews out. Owns no transport — the caller wires normalized
 * events to handleInbound/handleCardAction/onSessionEvent.
 */
import { parseCommand, guardDecision, translateGuardError, HELP_TEXT } from './commands.js'
import { formatAndSendText, buildStatusCard, renderChangesCard, renderDiffMessage, buildPostContent } from './formatter.js'

const FEISHU_SOURCE = 'feishu'

export class GatewayDriver {
  /** @param {{ ctx: any, lark: any, router: any, config: any, logger?: any, makeActionId?: () => string, answererCallback?: Function, listBindings?: () => Iterable<any> }} options */
  constructor({ ctx, lark, router, config, logger, makeActionId = (() => { let n = 0; return () => `act_${++n}` })(), answererCallback, listBindings }) {
    this.ctx = ctx
    this.lark = lark
    this.router = router
    this.config = config
    this.logger = logger
    this.makeActionId = makeActionId
    this.answererCallback = answererCallback ?? (() => {})
  }

  // --- inbound ---

  async handleInbound(message) {
    if (message.kind !== 'message') return
    const cmd = parseCommand(message.text, this.config.commandPrefix)
    if (cmd !== null) return this.runCommand(cmd, message)
    return this.deliverTask(message)
  }

  async runCommand(cmd, message) {
    const { chatId } = message
    try {
      switch (cmd.name) {
        case 'help': return void this.lark.sendText(chatId, HELP_TEXT)
        case 'status': return void this.sendStatus(chatId)
        case 'stop': {
          const agent = await this.activeAgent(chatId)
          agent?.interrupt?.()
          return void this.sendStatus(chatId)
        }
        case 'ws': return this.runWs(cmd, message)
        case 'session': return this.runSession(cmd, message)
        case 'model': return this.runModel(cmd, message)
        default: return void this.lark.sendText(chatId, `未知命令，试试：\n${HELP_TEXT}`)
      }
    } catch (error) {
      this.logger?.warn?.(`feishu-gateway: command failed: ${String(error)}`)
      return void this.lark.sendText(chatId, translateGuardError(error))
    }
  }

  async runWs(cmd, message) {
    const { chatId } = message
    if (cmd.sub === 'list') {
      const list = this.ctx.workspaceRegistry.list().map(w => `- **${w.title}**（\`${w.path}\`）`).join('\n')
      return void this.lark.sendJson(chatId, 'post', buildPostContent(`工作区：\n${list}`))
    }
    if (cmd.sub === 'use') {
      const title = cmd.args[0]
      const ws = this.ctx.workspaceRegistry.list().find(w => w.title === title || w.id === title)
      if (ws === undefined) return void this.lark.sendText(chatId, `没有叫「${title ?? ''}」的工作区，/ws list 看看。`)
      await this.router.bind(chatId, { workspaceId: ws.id, workspaceTitle: ws.title, workspacePath: ws.path })
      return void this.sendStatus(chatId)
    }
    if (cmd.sub === 'new') {
      const path = cmd.args[0]
      if (path === undefined) return void this.lark.sendText(chatId, '用法：/ws new <绝对路径> [标题]')
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      const ws = await this.ctx.workspaceRegistry.create(path, cmd.args[1])
      await this.router.bind(chatId, { workspaceId: ws.id, workspaceTitle: ws.title, workspacePath: ws.path })
      return void this.sendStatus(chatId)
    }
    return void this.lark.sendText(chatId, `用法：/ws list | use <名称> | new <路径> [标题]`)
  }

  async runSession(cmd, message) {
    const { chatId } = message
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '先 /ws use 绑定一个工作区。')
    if (cmd.sub === 'new') {
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      await this.openSession(chatId, binding)
      return void this.sendStatus(chatId)
    }
    if (cmd.sub === 'resume') {
      const history = await this.router.history(chatId)
      if (history.length === 0) return void this.lark.sendText(chatId, '没有可恢复的历史会话。')
      const actions = history.slice(0, 10).map((e, i) => ({
        tag: 'button', text: { tag: 'plain_text', content: e.title ?? e.sessionId }, type: 'default',
        value: { actionId: this.makeActionId(), kind: 'resume', sessionId: e.sessionId, title: e.title },
      }))
      return void this.lark.sendJson(chatId, 'interactive', {
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '恢复哪个会话？' }, template: 'blue' },
        elements: [{ tag: 'action', actions }],
      })
    }
    return void this.lark.sendText(chatId, '用法：/session new | resume')
  }

  async runModel(cmd, message) {
    const { chatId } = message
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '先 /ws use 绑定一个工作区。')
    if (cmd.args.length === 0) {
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      const providers = await this.ctx.llm.listModels()
      const actions = []
      for (const p of providers) {
        for (const m of p.models.slice(0, 20)) {
          actions.push({
            tag: 'button', text: { tag: 'plain_text', content: `${p.provider}/${m.id}` }, type: 'default',
            value: { actionId: this.makeActionId(), kind: 'model', provider: p.provider, model: m.id },
          })
        }
      }
      for (let i = 0; i < actions.length; i += 5) {
        await this.lark.sendJson(chatId, 'interactive', {
          config: { update_multi: true },
          header: { title: { tag: 'plain_text', content: '选择模型' }, template: 'blue' },
          elements: [{ tag: 'action', actions: actions.slice(i, i + 5) }],
        })
      }
      return
    }
    const [providerSlashModel] = cmd.args
    const [provider, model] = providerSlashModel.split('/')
    await this.selectModel(chatId, binding.activeSessionId, { provider, model })
    return void this.sendStatus(chatId)
  }

  // --- card actions ---

  async handleCardAction(action) {
    if (action.kind !== undefined && action.kind !== 'card-action') return
    const value = action.value ?? {}
    const { chatId } = action
    try {
      if (value.kind === 'diff') {
        const binding = await this.router.get(chatId)
        const diff = await this.ctx.workspaceChanges.diff(binding.activeSessionId, 0, 0)
        return void this.lark.sendJson(chatId, 'post', renderDiffMessage(value.path, diff?.diff ?? String(diff)))
      }
      if (value.kind === 'resume') {
        const guard = guardDecision({ running: await this.isRunning(chatId) })
        if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
        await this.ctx.agents.resume({ resumeSessionId: value.sessionId })
        await this.router.setActive(chatId, value.sessionId, value.title)
        return void this.sendStatus(chatId)
      }
      if (value.kind === 'model') {
        const binding = await this.router.get(chatId)
        await this.selectModel(chatId, binding.activeSessionId, { provider: value.provider, model: value.model })
        return void this.sendStatus(chatId)
      }
      // answer kinds belong to the answerer
      await this.answererCallback(action)
    } catch (error) {
      this.logger?.warn?.(`feishu-gateway: card action failed: ${String(error)}`)
      return void this.lark.sendText(chatId, translateGuardError(error))
    }
  }

  // --- session events ---

  async onSessionEvent(session, event) {
    const binding = [...await this.allBindings()].find(b => b.activeSessionId === session.id)
    if (binding === undefined) return
    if (event.type !== 'turn/end') return
    const agent = this.ctx.agents.get(session.id)
    const text = agent?.session?.lastAssistantText?.() ?? ''
    if (text !== '') await formatAndSendText(this.lark, binding.chatId, text, { chunkLimit: this.config.messageChunkLimit })
    const summary = this.ctx.workspaceChanges.summary?.(session.id, event.seq)
    if (summary !== undefined && summary.files?.length > 0) {
      await this.lark.sendJson(binding.chatId, 'interactive', renderChangesCard(summary, () => this.makeActionId()))
    }
  }

  // --- helpers ---

  /** All bindings, for matching session events back to chats. */
  async allBindings() {
    const iterable = this.listBindings ? this.listBindings() : this.router.bindings.values()
    return [...iterable]
  }

  async activeAgent(chatId) {
    const binding = await this.router.get(chatId)
    if (binding?.activeSessionId === undefined) return undefined
    return this.ctx.agents.get(binding.activeSessionId)
  }

  async isRunning(chatId) {
    const agent = await this.activeAgent(chatId)
    return agent?.status === 'running'
  }

  async openSession(chatId, binding) {
    const { agent } = await this.ctx.agents.create({
      meta: { cwd: binding.workspacePath },
    })
    this.ctx.workspaceRegistry.attachSession?.(binding.workspaceId, agent.session.id)
    await this.router.setActive(chatId, agent.session.id, agent.session.title?.())
    return agent
  }

  async deliverTask(message) {
    const binding = await this.router.get(message.chatId)
    if (binding === undefined) {
      return void this.lark.sendText(message.chatId, '先绑定工作区：/ws list 查看，/ws use <名称> 切换。')
    }
    const source = { kind: FEISHU_SOURCE, chatId: message.chatId, senderOpenId: message.senderOpenId, messageId: message.messageId }
    let agent = binding.activeSessionId !== undefined ? this.ctx.agents.get(binding.activeSessionId) : undefined
    if (agent === undefined) {
      agent = await this.openSession(message.chatId, binding)
    } else if (agent.status === 'running') {
      agent.steer?.(message.text, source)
      return
    }
    agent.followup(message.text, source)
  }

  async selectModel(chatId, sessionId, selection) {
    await this.ctx.apiSessions.selectModel({ sessionId, selection })
  }

  async sendStatus(chatId) {
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '尚未绑定工作区。/ws use <名称>')
    const agent = binding.activeSessionId !== undefined ? this.ctx.agents.get(binding.activeSessionId) : undefined
    await this.lark.sendJson(chatId, 'interactive', buildStatusCard({
      workspaceTitle: binding.workspaceTitle,
      workspacePath: binding.workspacePath,
      sessionTitle: agent?.session?.title?.() ?? binding.activeSessionTitle ?? '（无会话）',
      sessionId: binding.activeSessionId ?? '（无）',
      model: agent?.session?.currentModel?.() ?? '默认',
      modelPending: agent?.session?.pendingModel?.() === true,
      running: agent?.status === 'running',
    }))
  }
}
```

（driver 的 `onSessionEvent` 通过 `allBindings()`（默认遍历 `router.bindings.values()`，可用 `listBindings` 注入覆盖）把 session 事件映射回 chat。）

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/driver.spec.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): driver — command execution, session orchestration, outbound forwarding"
```

---

### Task 7: Answerer — 提问/审批 waterfall 应答者

**Files:**
- Create: `packages/feishu-gateway/lib/answerer.js`
- Test: `packages/feishu-gateway/tests/answerer.spec.js`

**Interfaces:**
- Consumes: Task 1 `LarkClient`、Task 3 `buildQuestionCard/buildApprovalCard`。
- Produces:
  - `class GatewayAnswerer { constructor({ lark, config, logger, makeActionId, time }) ; attach(ctx)（注册两个全局 waterfall 监听器，返回 disposer） ; async handleUserQuestions(request, next) ; async handleApproval(request, next) ; async handleCardAction(action) }`；
  - 路由条件：`request.agent?.session` 的最近 user message source kind === 'feishu'（driver 记录的会话才能被识别；识别函数 `isFeishuSession(request)` 从 `request.agent` 的 session 投影读取 `source`——测试直接注入）；
  - pending map：`Map<actionId, { resolve, kind, payload }>`；card-action 到达时 resolve；
  - 超时续答：waterfall Promise 已 reject/resolve（timed 窗口关闭）后收到答案 → 调 `ctx.userQuestions.answer(agent, callId, answer)`（callId 从 request 携带）。

- [ ] **Step 1: Write the failing test**

```js
// tests/answerer.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayAnswerer } from '../lib/answerer.js'

function makeAnswerer() {
  const sent = []
  const lark = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, mt, content) => sent.push({ type: mt, content }),
  }
  let n = 0
  const answerer = new GatewayAnswerer({
    lark, config: {}, logger: console,
    makeActionId: () => `act_${++n}`,
  })
  return { answerer, sent }
}

function feishuRequest(questions) {
  return {
    questions,
    callId: 'call_1',
    agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } },
  }
}

test('routes feishu-origin questions to a card and resolves on click', async () => {
  const { answerer, sent } = makeAnswerer()
  let resolvedByNext = false
  const answerPromise = answerer.handleUserQuestions(feishuRequest([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }]), async () => { resolvedByNext = true })
  await Promise.resolve()
  assert.equal(resolvedByNext, false, 'did not delegate to next')
  assert.ok(sent.some(s => s.type === 'interactive' && /Proceed\?/.test(JSON.stringify(s.content))))
  // user clicks Yes (choice 0)
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'answer', questionId: 'q1', choice: 0 } })
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ questionId: 'q1', selectedLabels: ['Yes'] }])
})

test('non-feishu sessions delegate via next()', async () => {
  const { answerer, sent } = makeAnswerer()
  const request = { questions: [{ id: 'q1', question: 'x', options: [] }], callId: 'c', agent: { session: { id: 's9', lastUserSource: () => ({ kind: 'web' }) } } }
  const result = await answerer.handleUserQuestions(request, async () => 'delegated')
  assert.equal(result, 'delegated')
  assert.equal(sent.length, 0)
})

test('late answer after window close goes through userQuestions.answer', async () => {
  const { answerer } = makeAnswerer()
  const answered = []
  answerer.setUserQuestionsService({ answer: async (agent, callId, ans) => answered.push({ callId, ans }) })
  const request = feishuRequest([{ id: 'q1', question: 'x', options: [{ label: 'A' }] }])
  // window already closed: the waterfall promise rejected with timeout earlier;
  // simulate by marking the pending entry dead
  const p = answerer.handleUserQuestions(request, async () => { throw new Error('timeout') })
  await Promise.resolve()
  answerer.killPending('act_1') // test seam: the timed window expired
  await assert.rejects(p)
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'answer', questionId: 'q1', choice: 0 } })
  assert.equal(answered.length, 1)
  assert.equal(answered[0].callId, 'call_1')
})

test('approval outcomes map to DSH semantics', async () => {
  const { answerer, sent } = makeAnswerer()
  const request = { prompt: 'rm -rf', agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } } }
  const outcomePromise = answerer.handleApproval(request, async () => 'delegated')
  await Promise.resolve()
  assert.ok(sent.some(s => /允许一次/.test(JSON.stringify(s.content))))
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'approval', outcome: 'allow-once' } })
  assert.deepEqual(await outcomePromise, { decision: 'allow-once' })
})

test('unknown action ids are ignored', async () => {
  const { answerer } = makeAnswerer()
  assert.equal(await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'nope', kind: 'answer', choice: 0 } }), undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/answerer.spec.js`
Expected: FAIL（module not found）

- [ ] **Step 3: Write minimal implementation**

```js
// lib/answerer.js
/**
 * The gateway as a Cordis waterfall Answerer: structured questions and
 * approval requests from feishu-origin sessions round-trip as interactive
 * cards; everything else is delegated with next().
 */
import { buildQuestionCard, buildApprovalCard } from './formatter.js'

/** The answer shape DSH's userQuestions.ask() expects. */
const OUTCOMES = new Set(['allow-once', 'allow-session', 'allow-always', 'deny'])

/** True when the requesting agent's session belongs to this gateway. */
function isFeishuSession(request) {
  const source = request.agent?.session?.lastUserSource?.()
  return source?.kind === 'feishu' && typeof source.chatId === 'string'
}

export class GatewayAnswerer {
  /** @param {{ lark: any, config?: any, logger?: any, makeActionId: () => string }} options */
  constructor({ lark, config = {}, logger, makeActionId }) {
    this.lark = lark
    this.config = config
    this.logger = logger
    this.makeActionId = makeActionId
    /** @type {Map<string, { resolve: Function, kind: string, request: any }>} */
    this.pending = new Map()
    /** @type {any} */
    this.userQuestions = undefined
  }

  /** Test/apply seam for the ctx.userQuestions service. */
  setUserQuestionsService(service) { this.userQuestions = service }

  /** Register the two global waterfall listeners; returns a disposer. */
  attach(ctx) {
    const offQuestion = ctx.on('user-questions/request', (request, next) => this.handleUserQuestions(request, next), { global: true })
    const offApproval = ctx.on('approval/request', (request, next) => this.handleApproval(request, next), { global: true })
    return () => { offQuestion(); offApproval() }
  }

  /** user-questions waterfall: route feishu sessions to cards, else next(). */
  async handleUserQuestions(request, next) {
    if (!isFeishuSession(request)) return next()
    const chatId = request.agent.session.lastUserSource().chatId
    // v1 handles the first question only; later questions follow after answer.
    const question = request.questions?.[0]
    if (question === undefined) return next()
    const actionId = this.makeActionId()
    const answer = await this.roundTrip(chatId, actionId, 'question', request,
      buildQuestionCard(question, actionId))
    if (answer.timedOut) return next()
    const choice = answer.value.choice
    const label = question.options?.[choice]?.label ?? ''
    return { answers: [{ questionId: question.id, selectedLabels: [label] }] }
  }

  /** approval waterfall: route feishu sessions to an allow/deny card, else next(). */
  async handleApproval(request, next) {
    if (!isFeishuSession(request)) return next()
    const chatId = request.agent.session.lastUserSource().chatId
    const actionId = this.makeActionId()
    const outcome = await this.roundTrip(chatId, actionId, 'approval', request,
      buildApprovalCard(String(request.prompt ?? request.reason ?? '权限请求'), actionId))
    if (outcome.timedOut) return next()
    return { decision: outcome.value.outcome }
  }

  /** Send the card and await the matching card action (or timeout). */
  roundTrip(chatId, actionId, kind, request, card) {
    return new Promise(resolve => {
      const entry = { resolve, kind, request, dead: false }
      this.pending.set(actionId, entry)
      this.lark.sendJson(chatId, 'interactive', card).catch(error => {
        this.logger?.warn?.(`feishu-gateway: card send failed: ${String(error)}`)
        this.pending.delete(actionId)
        resolve({ timedOut: true })
      })
    })
  }

  /** Test seam marking a pending entry dead (the timed window closed). */
  killPending(actionId) {
    const entry = this.pending.get(actionId)
    if (entry !== undefined) {
      entry.dead = true
      entry.resolve({ timedOut: true })
      // keep the entry so a late click can still route to userQuestions.answer
      entry.late = { callId: entry.request.callId, agent: entry.request.agent }
    }
  }

  /** Resolve one card action against the pending map (or late-answer path). */
  async handleCardAction(action) {
    const value = action.value ?? {}
    if (value.actionId === undefined) return undefined
    const entry = this.pending.get(value.actionId)
    if (entry === undefined) return undefined
    if (entry.dead) {
      // late answer: the waterfall already closed — route via userQuestions.answer
      if (entry.kind === 'question' && entry.late !== undefined && this.userQuestions !== undefined) {
        const question = entry.request.questions?.[0]
        const label = question?.options?.[value.choice]?.label ?? ''
        await this.userQuestions.answer(entry.late.agent, entry.late.callId, {
          answers: [{ questionId: value.questionId, selectedLabels: [label] }],
        })
      }
      this.pending.delete(value.actionId)
      return undefined
    }
    this.pending.delete(value.actionId)
    entry.resolve({ value, timedOut: false })
    return undefined
  }
}
```

注：`attach(ctx)` 中的事件注册签名按 Cordis waterfall 约定 `(payload, next)`；真实 host 的请求对象字段（`questions`/`callId`/`agent.session.lastUserSource`）以 dsh 源码 `packages/interaction/user-questions/src/index.ts` 为准——Task 8 接线时如字段名有出入（例如 source 需从 session 投影读取），只改 `isFeishuSession` 与 `feishuRequest` 的取值路径，不改结构。approval 的 outcome 值（`allow-once` 等）同样对照 `packages/interaction/user-approval` 的 `ApprovalOutcome` 类型在 Task 8 校正。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test tests/answerer.spec.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): waterfall answerer with card round-trip and late-answer path"
```

---

### Task 8: apply() 接线、README、集成冒烟

**Files:**
- Create: `packages/feishu-gateway/index.js`
- Create: `packages/feishu-gateway/README.md`
- Test: `packages/feishu-gateway/tests/wiring.spec.js`

**Interfaces:**
- Consumes: Task 1–7 全部导出；真实 host ctx（`ctx.inject`、`ctx.effect`、`ctx.on('session/event', …, { global: true })`、`ctx.storageDomain`/storage 持久化、`ctx.logger`）。
- Produces: `export function apply(ctx, config)`（bundle 入口）、`export const Config`（re-export）。

- [ ] **Step 1: Write the failing test**

```js
// tests/wiring.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const here = fileURLToPath(new URL('.', import.meta.url))

/** A ctx double capturing effect/inject/on usage. */
function makeCtx() {
  const registered = { effects: [], events: [], injects: [] }
  const ctx = {
    logger: console,
    on(name) { registered.events.push(name); return () => {} },
    effect(fn) { registered.effects.push(fn); return () => {} },
    inject(deps, fn) { registered.injects.push(deps); fn(ctx); return () => {} },
    registered,
  }
  return ctx
}

test('apply without credentials stays inert (no transport, one log line)', async () => {
  const ctx = makeCtx()
  apply(ctx, { appId: '', appSecret: '', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  assert.equal(ctx.registered.injects.length, 0)
})

test('apply with credentials wires transport, driver, answerer, session events', async () => {
  const ctx = makeCtx()
  // Fake the SDK so no network is touched: index.js must expose a seam for it.
  const { setSdkForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class { async start() {} },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(ctx, { appId: 'cli_x', appSecret: 'sec', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  assert.ok(ctx.registered.injects.some(d => Array.isArray(d) && d.includes('agents')))
  assert.ok(ctx.registered.events.includes('session/event'))
  assert.ok(ctx.registered.effects.length > 0)
})

test('package.json declares the runtime SDK dependency and bundle patch', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.dependencies['@larksuiteoapi/node-sdk'])
})

test('README covers install, config, and the Feishu console checklist', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const needle of ['im.message.receive_v1', 'card.action.trigger', '长连接', 'FEISHU_APP_ID', '/ws use']) {
    assert.ok(readme.includes(needle), `README missing: ${needle}`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/feishu-gateway && node --test tests/wiring.spec.js`
Expected: FAIL（`Cannot find module '../index.js'`）

- [ ] **Step 3: Write minimal implementation**

```js
// index.js
/**
 * dsh-feishu-gateway — Host half.
 *
 * Wires the modules into the host: the SDK client (credentials from the
 * Loader row, env-defaulted), the long-connection transport, the binding
 * router (persisted through ctx.storageDomain — see createDomainPersist),
 * the driver, and the answerer. Inert until appId/appSecret are configured.
 */
import { z } from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Config as RowConfig } from './lib/config.js'
import { LarkClient, readConfigString } from './lib/lark-client.js'
import { startGatewayTransport } from './lib/transport.js'
import { BindingRouter } from './lib/router.js'
import { GatewayDriver } from './lib/driver.js'
import { GatewayAnswerer } from './lib/answerer.js'

/** @type {any} */
let sdkOverride = undefined

/** Test seam: inject a fake SDK (Client/WSClient/EventDispatcher/LoggerLevel). */
export function setSdkForTests(fake) { sdkOverride = fake }

async function loadSdk() {
  return sdkOverride ?? await import('@larksuiteoapi/node-sdk')
}

/** The chat-binding KV domain (SPEC: bindings persist through storage domain). */
const bindingDomain = defineDomain({
  name: 'feishu-gateway-bindings',
  version: 1,
  tables: {
    bindings: domainTable(z.object({
      chatId: z.string(),
      workspaceId: z.string(),
      workspaceTitle: z.string(),
      workspacePath: z.string(),
      activeSessionId: z.string().optional(),
      activeSessionTitle: z.string().optional(),
      sessionHistory: z.array(z.object({ sessionId: z.string(), title: z.string() })),
      updatedAt: z.number(),
    })),
  },
})

/**
 * BindingRouter persistence over the storage domain table (chatId key);
 * falls back to memory when the host exposes no storageDomain service.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function createDomainPersist(ctx) {
  let table = undefined
  return {
    async load() {
      if (ctx.storageDomain === undefined) return undefined
      const domain = await ctx.storageDomain.open(bindingDomain)
      table = domain.table('bindings')
      return [...table.keys?.() ?? []].flatMap(k => {
        const rec = table.get(k)
        return rec === undefined ? [] : [rec]
      })
    },
    async save(state) {
      if (table === undefined) return
      const live = new Map(state.map(b => [b.chatId, b]))
      for (const key of table.keys?.() ?? []) {
        if (!live.has(key)) await table.delete?.(key)
      }
      for (const b of live.values()) await table.put(b.chatId, b)
    },
  }
}

export const Config = RowConfig

/**
 * Mount the gateway. Requires the host services the driver consumes; stays
 * inert with one log line when credentials are not configured.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ appId?: unknown, appSecret?: unknown, domain?: unknown, commandPrefix?: unknown, messageChunkLimit?: unknown }} config
 */
export function apply(ctx, config) {
  const appId = readConfigString(config.appId)
  const appSecret = readConfigString(config.appSecret)
  if (appId === '' || appSecret === '') {
    ctx.logger.info?.('feishu-gateway: FEISHU_APP_ID/FEISHU_APP_SECRET not configured — gateway inactive')
    return
  }
  const resolved = {
    appId,
    appSecret,
    domain: readConfigString(config.domain) || 'https://open.feishu.cn',
    commandPrefix: readConfigString(config.commandPrefix) || '/',
    messageChunkLimit: Number(config.messageChunkLimit) > 0 ? Number(config.messageChunkLimit) : 8000,
  }

  ctx.inject(['agents', 'workspaceRegistry', 'apiSessions', 'workspaceChanges', 'llm'], async (scope) => {
    const Lark = await loadSdk()
    const sdkClient = new Lark.Client({ appId: resolved.appId, appSecret: resolved.appSecret, domain: resolved.domain })
    const lark = new LarkClient({ sdkClient, logger: scope.logger })
    let actionSeq = 0
    const makeActionId = () => `fg_${Date.now().toString(36)}_${++actionSeq}`

    const router = new BindingRouter({ persist: createDomainPersist(scope) })
    await router.load()

    const answerer = new GatewayAnswerer({ lark, config: resolved, logger: scope.logger, makeActionId })
    const driver = new GatewayDriver({
      ctx: scope, lark, router, config: resolved, logger: scope.logger, makeActionId,
      answererCallback: action => answerer.handleCardAction(action),
    })

    scope.effect(() => {
      const stopTransport = startGatewayTransport({
        config: resolved,
        handlers: {
          onMessage: n => driver.handleInbound(n),
          onCardAction: n => n.value?.kind === 'diff' || n.value?.kind === 'resume' || n.value?.kind === 'model'
            ? driver.handleCardAction(n)
            : answerer.handleCardAction(n),
        },
        logger: scope.logger,
      })
      const detachAnswerer = answerer.attach(scope)
      const offSessionEvents = scope.on('session/event', (session, event) => {
        driver.onSessionEvent(session, event).catch(e => scope.logger.warn?.(`feishu-gateway: session event failed: ${String(e)}`))
      }, { global: true })
      return () => { offSessionEvents(); detachAnswerer(); stopTransport?.() }
    }, 'dsh-feishu-gateway: transport + answerer + session events')
  })
}
```

注：`domain.table('bindings')` 的 `keys()`/`delete()` 方法名以 `@deepseek-ai/dsh-storage-domain` 的 README/table API 为准（本计划撰写时已核对 `put/get/update`；若 `keys` 不可用，改用 `update(chatId, …)` upsert 语义并跳过删除分支——绑定数量级为一 chat 一条，遗留旧记录无害）。package.json 需追加 peer `@deepseek-ai/dsh-storage-domain`。

README.md 内容（完整写入）：

```md
# dsh-feishu-gateway

飞书（Lark）机器人网关：把一个飞书自建应用机器人的 **p2p 单聊**接入 dsh。
消息驱动绑定的 workspace 会话执行任务；结构化提问与权限审批以交互卡片
往返；支持在 chat 内切换工作区 / 会话 / 模型，切换后回显状态卡。

- 设计文档：`docs/specs/2026-10-09-feishu-gateway-design.md`
- 依赖官方飞书 Node SDK（`@larksuiteoapi/node-sdk`，纯 JS 无构建脚本）

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsharp/packages/feishu-gateway
```

## 配置

环境层（`~/.dsh/.env` 或调用目录 `.env`），或 Plugins 页面表单（优先）：

```sh
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=https://open.feishu.cn   # 海外用 https://open.larksuite.com
```

未配置凭证时插件静默 inactive（日志提示一次）。

## 飞书开发者后台 checklist

1. 企业自建应用 → 添加应用能力 → **机器人**；**创建版本并发布**（能力发布后才生效）。
2. 权限（发布后生效）：`im:message`、`im:message.p2p_msg`、`im:chat:readonly`、`im:resource`。
3. 事件与回调 → 事件配置：订阅方式选 **使用长连接接收事件**，添加事件 `im.message.receive_v1`。
4. 事件与回调 → 回调配置：选 **长连接**，配置 `card.action.trigger`。
   （`card.action.trigger` 必须配在回调配置，不是事件订阅；点按钮报 200340 通常是这里配错。）
5. 可用范围：把使用者加入应用可用范围，用户才能与机器人单聊。

## Chat 命令

| 命令 | 作用 |
|---|---|
| `/ws list` | 列出所有工作区 |
| `/ws use <名称>` | 切换绑定的工作区（纯指针切换，不受运行限制） |
| `/ws new <路径> [标题]` | 注册新工作区并绑定 |
| `/session new` | 当前工作区开新会话（需会话空闲） |
| `/session resume` | 从会话历史恢复（卡片选择；需空闲） |
| `/stop` | 打断当前回合 |
| `/model` | 选择模型（卡片；需空闲） |
| `/status` | 当前状态卡 |
| `/help` | 帮助 |

普通文本消息进入当前活动会话；会话运行中的消息作为 steer 插入。
每回合结束发送最终回复（markdown → 飞书富文本，超长分片）与改动摘要卡
（可按文件点开 unified diff）。提问与权限请求以卡片按钮作答，迟到答案
自动走续答通道。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/feishu-gateway && node --test "tests/*.spec.js"`
Expected: 全部 PASS（lark-client 3 + transport 6 + formatter 10 + router 3 + commands 7 + driver 5 + answerer 5 + wiring 4）

- [ ] **Step 5: Commit**

```bash
git add packages/feishu-gateway
git commit -m "feat(feishu-gateway): apply wiring, README with console checklist, integration smoke test"
```

---

## Final verification（收尾，非独立任务）

1. `cd packages/feishu-gateway && node --test "tests/*.spec.js"` 全绿。
2. `pnpm -r pack` 产出 tarball 无错（SDK 依赖会写入 tarball 的 package.json）。
3. 更新仓库根 README 的 Packages 表，加 feishu-gateway 一行，`docs: add feishu-gateway to package table` 提交。
4. 对照 SPEC 逐条用户故事勾验收（1/2/9/10/13/14 由单测覆盖；3–8 由 driver/commands 测试覆盖；11/12 由 answerer 测试覆盖）。
