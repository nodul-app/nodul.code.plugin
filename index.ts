import { Integration, Plugin, Provider } from "@opencode/plugin"
import type { Model } from "@opencode/plugin"
import { WEB_SEARCH, keepIntegration, keepProvider, pickDefault } from "./src/allowlist.ts"
import { fetchModels } from "./src/fetch.ts"
import { PACKAGE, PROVIDER_ID, toModels } from "./src/models.ts"

const DEFAULT_BASE_URL = "https://router.nodul.ru/api/v1"
const DEFAULT_MODEL = "ru-2/deepseek-v4.1-flash"
const REFRESH_INTERVAL = 10 * 60 * 1000
const FIRST_LOAD_TIMEOUT = 5_000

type Connection = NonNullable<Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>>

// Same identity OpenCode uses to tell connections apart (IntegrationConnection.key in core).
const connectionKey = (connection: Connection | undefined) =>
  connection === undefined
    ? undefined
    : connection.type === "credential"
      ? `credential:${connection.id}`
      : `env:${connection.name}`

export default Plugin.define({
  id: "nodul.router",
  async setup(ctx) {
    const baseURL: string = ctx.options.baseURL ?? DEFAULT_BASE_URL
    const defaultModel: string = ctx.options.defaultModel ?? DEFAULT_MODEL
    const webSearch = new Set(WEB_SEARCH)
    const providerID = Provider.ID.make(PROVIDER_ID)
    // The last list the router returned for the active key; kept through network errors.
    const loaded: { models?: Model.Info[]; connection?: Connection } = {}

    // Transforms run synchronously on every rebuild; a throw here would disable the whole plugin.
    await ctx.integration.transform((editor) => {
      for (const integration of editor.list()) {
        if (!keepIntegration(integration.id, webSearch)) editor.remove(integration.id)
      }
      editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "Nodul API key" } })
      editor.method.update({ integrationID: PROVIDER_ID, method: { type: "env", names: ["NODUL_ROUTER_API_KEY"] } })
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = "Nodul Router"
      })
    })

    await ctx.provider.transform((editor) => {
      for (const record of editor.list()) {
        if (!keepProvider(record.provider.id)) editor.remove(record.provider.id)
      }
      if (!loaded.models) return
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Nodul Router",
          activation: "auto",
          integrationID: Integration.ID.make(PROVIDER_ID),
          package: PACKAGE,
          // No apiKey: OpenCode injects the key from the user's Nodul credential.
          settings: { baseURL, provider: PROVIDER_ID },
        },
        models: loaded.models,
        // Bound to the key that produced it, so switching keys hides this list at once.
        sourceConnection: loaded.connection,
      })
    })

    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        if (model.providerID !== PROVIDER_ID) editor.remove(model.providerID, model.id)
      }
      const id = pickDefault(editor.list(PROVIDER_ID), defaultModel)
      if (id) editor.default.set(PROVIDER_ID, id)
    })

    const load = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      const credential = connection
        ? await ctx.integration.connection.resolve(connection).catch(() => undefined)
        : undefined
      if (!connection || credential?.type !== "key") {
        loaded.models = undefined
        loaded.connection = undefined
        return
      }

      const result = await fetchModels(baseURL, credential.key)
      // The key may have changed while the request was in flight; its own refresh is already queued.
      if (connectionKey(connection) !== connectionKey(await ctx.integration.connection.active(PROVIDER_ID))) return

      if (result.type === "unavailable") {
        console.warn(`[nodul] keeping the last model list: ${result.reason}`)
        return
      }
      if (result.type === "unauthorized") {
        loaded.models = undefined
        loaded.connection = undefined
        await ctx.integration.connection
          .status({
            integrationID: PROVIDER_ID,
            connection,
            status: { status: "needs_auth", message: "Nodul Router rejected this API key" },
          })
          .catch(() => {})
        return
      }
      loaded.models = toModels(result.data, baseURL)
      loaded.connection = connection
      await ctx.integration.connection
        .status({ integrationID: PROVIDER_ID, connection, status: undefined })
        .catch(() => {})
    }

    // One refresh at a time, in order, like the Semaphore(1) in OpenCode's own provider plugins.
    let queue = Promise.resolve()
    const refresh = () => {
      queue = queue
        .then(load)
        .then(() => ctx.provider.reload())
        .catch((error) => console.warn("[nodul] model refresh failed", error))
      return queue
    }

    const abort = new AbortController()
    void (async () => {
      const events = ctx.event.subscribe({
        types: ["credential.switched", "credential.updated"],
        signal: abort.signal,
      })
      for await (const event of events) {
        if (event.type === "credential.switched" && event.data.integrationID !== PROVIDER_ID) continue
        void refresh()
      }
    })().catch((error) => {
      if (!abort.signal.aborted) console.warn("[nodul] stopped watching key changes", error)
    })

    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL)
    // OpenCode starts the plugin for each project directory, and a session created before the first load
    // finds no model. Wait for it briefly; a slow router only delays activation, never blocks it.
    await Promise.race([refresh(), new Promise((resolve) => setTimeout(resolve, FIRST_LOAD_TIMEOUT))])

    return () => {
      abort.abort()
      clearInterval(timer)
    }
  },
})
