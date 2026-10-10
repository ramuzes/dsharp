import Schema from '@deepseek-ai/schemastery'

/**
 * Row configuration for the feishu-gateway Loader entry. The secret never
 * lives here: `appSecretEnv` names the credential reference the Plugins-page
 * secret control writes into (and the launch environment may supply), and
 * the Host resolves it through `ctx.credentials` per boot. The form card
 * does not render this field — users only see the App Secret control.
 */
export const Config = Schema.object({
  appId: Schema.string().default('').volatile(),
  appSecretEnv: Schema.string().role('credential-ref').default('FEISHU_APP_SECRET').volatile(),
  domain: Schema.string().default('https://open.feishu.cn').volatile(),
  commandPrefix: Schema.string().default('/').volatile(),
  messageChunkLimit: Schema.number().default(8000).volatile(),
})
