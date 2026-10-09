import Schema from '@deepseek-ai/schemastery'

/**
 * Row configuration for the feishu-gateway Loader entry. Edited as a form on
 * the Plugins page; `appSecretEnv` is a credential reference (an
 * environment-variable name) resolved per boot through `ctx.credentials`,
 * the same seam the built-in model routes use — the secret itself never
 * lives in the patch layer.
 */
export const Config = Schema.object({
  appId: Schema.string().default('').volatile(),
  appSecretEnv: Schema.string().role('credential-ref').default('FEISHU_APP_SECRET').volatile(),
  domain: Schema.string().default('https://open.feishu.cn').volatile(),
  commandPrefix: Schema.string().default('/').volatile(),
  messageChunkLimit: Schema.number().default(8000).volatile(),
})
