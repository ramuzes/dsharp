import Schema from '@deepseek-ai/schemastery'

/**
 * Row configuration for the feishu-gateway Loader entry. The secret never
 * lives here: `appSecretEnv` names the credential reference the Plugins-page
 * secret control writes into (and the launch environment may supply), and
 * the Host resolves it through `ctx.credentials` per boot. The form card
 * does not render this field — users only see the App Secret control.
 *
 * Every field is volatile: in DSH settings, volatile marks a field the
 * Plugins-page form can edit LIVE (settings.mutate writes the accepted value
 * into the profile patch — volatile does NOT mean "do not persist"). An
 * entry whose schema has no volatile field is dropped from the settings
 * document entirely and its form shows "configuration unavailable".
 */
export const Config = Schema.object({
  appId: Schema.string().default('').volatile(),
  appSecretEnv: Schema.string().role('credential-ref').default('FEISHU_APP_SECRET').volatile(),
  domain: Schema.string().default('https://open.feishu.cn').volatile(),
  commandPrefix: Schema.string().default('/').volatile(),
  messageChunkLimit: Schema.number().default(8000).volatile(),
})
