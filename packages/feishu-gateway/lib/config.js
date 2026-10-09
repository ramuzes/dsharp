import Schema from '@deepseek-ai/schemastery'

/** Row configuration for the feishu-gateway Loader entry. */
export const Config = Schema.object({
  appId: Schema.string().default('').volatile(),
  appSecret: Schema.string().role('secret').default('').volatile(),
  domain: Schema.string().default('https://open.feishu.cn').volatile(),
  commandPrefix: Schema.string().default('/').volatile(),
  messageChunkLimit: Schema.number().default(8000).volatile(),
})
