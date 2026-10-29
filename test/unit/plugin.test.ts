import { afterEach, describe, expect, test } from "bun:test"
import plugin from "../../index.ts"

// The 21 integrations OpenCode 2.2 lists when the models.dev catalog is empty.
const INTEGRATIONS = [
  "amazon-bedrock", "azure", "cloudflare-ai-gateway", "cloudflare-workers-ai", "databricks", "digitalocean",
  "exa", "firecrawl", "github-copilot", "gitlab", "google-vertex", "neon", "openai", "opencode", "parallel",
  "poe", "snowflake-cortex", "tavily", "tinyfish", "xai",
]

type Credential = { type: "key"; key: string } | undefined
type Connection = { type: "credential"; id: string; label: string; method: "key" }

/** In-memory stand-ins for OpenCode's editors, seeded like a fresh 2.2 install. */
function harness(options: { router: (key: string) => Response | Promise<Response>; credential?: Credential }) {
  const transforms = { integration: [] as Function[], provider: [] as Function[], model: [] as Function[] }
  const statuses: unknown[] = []
  let credential = options.credential
  let connection: Connection | undefined = credential ? { type: "credential", id: "cred_1", label: "k", method: "key" } : undefined
  let reloads = 0

  const ctx = {
    options: { baseURL: "http://router.test/api/v1" },
    integration: {
      transform: async (fn: Function) => void transforms.integration.push(fn),
      connection: {
        active: async () => connection,
        resolve: async () => credential,
        status: async (input: unknown) => void statuses.push(input),
      },
    },
    provider: { transform: async (fn: Function) => void transforms.provider.push(fn), reload: async () => void reloads++ },
    model: { transform: async (fn: Function) => void transforms.model.push(fn) },
    event: {
      subscribe: (input: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!input.signal.aborted) {
            const next = await new Promise<unknown>((resolve) => {
              emit = resolve
              input.signal.addEventListener("abort", () => resolve(undefined), { once: true })
            })
            if (next) yield next
          }
        },
      }),
    },
  }
  let emit: (event: unknown) => void = () => {}

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: RequestInit) =>
    options.router(new Headers(init.headers).get("authorization")!.replace("Bearer ", ""))) as unknown as typeof fetch

  const integrations = () => {
    const items = new Map(INTEGRATIONS.map((id) => [id, { id, name: id }]))
    const methods = new Map<string, unknown[]>()
    const editor = {
      list: () => [...items.values()],
      get: (id: string) => items.get(id),
      update: (id: string, fn: Function) => fn(items.get(id) ?? items.set(id, { id, name: id }).get(id)),
      remove: (id: string) => void items.delete(id),
      method: {
        update: (input: { integrationID: string; method: unknown }) => {
          if (!items.has(input.integrationID)) items.set(input.integrationID, { id: input.integrationID, name: input.integrationID })
          methods.set(input.integrationID, [...(methods.get(input.integrationID) ?? []), input.method])
        },
      },
    }
    transforms.integration.forEach((fn) => fn(editor))
    return { ids: [...items.keys()].sort(), methods }
  }

  const providers = () => {
    const records = new Map<string, any>([
      ["opencode", { provider: { id: "opencode", activation: "enabled", settings: { apiKey: "public" } }, models: new Map() }],
      ["github-copilot", { provider: { id: "github-copilot", activation: "auto" }, models: new Map() }],
    ])
    const editor = {
      list: () => [...records.values()],
      remove: (id: string) => void records.delete(id),
      add: (input: any) => void records.set(input.info.id, { provider: input.info, models: input.models, sourceConnection: input.sourceConnection }),
    }
    transforms.provider.forEach((fn) => fn(editor))
    return records
  }

  const models = (list: { providerID: string; id: string; enabled: boolean }[]) => {
    let items = [...list]
    let selected: [string, string] | undefined
    const editor = {
      list: (providerID?: string) => items.filter((m) => !providerID || m.providerID === providerID),
      remove: (providerID: string, id: string) => (items = items.filter((m) => m.providerID !== providerID || m.id !== id)),
      default: { set: (providerID: string, id: string) => (selected = [providerID, id]) },
    }
    transforms.model.forEach((fn) => fn(editor))
    return { ids: items.map((m) => `${m.providerID}/${m.id}`), selected }
  }

  return {
    ctx,
    integrations,
    providers,
    models,
    statuses,
    reloads: () => reloads,
    /** Stores a new key the way the UI does and announces it. */
    async switchKey(next: Credential) {
      credential = next
      connection = next ? { type: "credential", id: `cred_${next.key}`, label: "k", method: "key" } : undefined
      emit({ type: "credential.switched", data: { integrationID: "nodul", credentialID: connection?.id ?? null } })
      await settle()
    },
    /** A refresh for the same key, as the 10-minute timer or a credential edit triggers. */
    async refreshSameKey() {
      emit({ type: "credential.updated", data: {} })
      await settle()
    },
    restore: () => (globalThis.fetch = realFetch),
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const model = (id: string) => ({ id, name: id, supported_parameters: ["tools"], context_length: 1000 })

let cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.forEach((fn) => fn())
  cleanup = []
})

// Background refreshes run on the event loop; give them a moment to finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

async function start(h: ReturnType<typeof harness>) {
  const dispose = await plugin.setup(h.ctx as never)
  cleanup.push(() => (dispose as () => void)(), h.restore)
  await settle()
}

describe("plugin", () => {
  test("hides every LLM integration but keeps Nodul and web search", async () => {
    const h = harness({ router: () => json({ data: [] }) })
    await start(h)
    const { ids, methods } = h.integrations()
    expect(ids).toEqual(["exa", "firecrawl", "nodul", "parallel", "tavily", "tinyfish"])
    expect(methods.get("nodul")).toEqual([
      { type: "key", label: "Nodul API key" },
      { type: "env", names: ["NODUL_ROUTER_API_KEY"] },
    ])
  })

  test("without a key: no providers at all, Nodul waits for a key", async () => {
    const h = harness({ router: () => json({ data: [model("x")] }) })
    await start(h)
    expect([...h.providers().keys()]).toEqual([])
  })

  test("with a key: only Nodul with that key's models, bound to the key", async () => {
    const h = harness({
      credential: { type: "key", key: "sk-nr-alice" },
      router: (key) => json({ data: key === "sk-nr-alice" ? [model("a/one"), model("ru-2/deepseek-v4.1-flash")] : [] }),
    })
    await start(h)
    const records = h.providers()
    expect([...records.keys()]).toEqual(["nodul"])
    const nodul = records.get("nodul")
    expect(nodul.provider).toMatchObject({
      id: "nodul",
      activation: "auto",
      integrationID: "nodul",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://router.test/api/v1", provider: "nodul" },
    })
    expect(nodul.provider.settings.apiKey).toBeUndefined()
    expect(nodul.models.map((m: any) => m.id)).toEqual(["a/one", "ru-2/deepseek-v4.1-flash"])
    expect(nodul.sourceConnection).toMatchObject({ id: "cred_1" })
    expect(h.reloads()).toBeGreaterThan(0)
  })

  test("model transform drops foreign models and selects the default", async () => {
    const h = harness({ router: () => json({ data: [] }) })
    await start(h)
    const result = h.models([
      { providerID: "opencode", id: "free", enabled: true },
      { providerID: "nodul", id: "a/one", enabled: true },
      { providerID: "nodul", id: "ru-2/deepseek-v4.1-flash", enabled: true },
    ])
    expect(result.ids).toEqual(["nodul/a/one", "nodul/ru-2/deepseek-v4.1-flash"])
    expect(result.selected).toEqual(["nodul", "ru-2/deepseek-v4.1-flash"])
    expect(h.models([{ providerID: "nodul", id: "a/one", enabled: true }]).selected).toEqual(["nodul", "a/one"])
  })

  test("a rejected key clears the list and flags the connection", async () => {
    const h = harness({ credential: { type: "key", key: "sk-nr-bad" }, router: () => json({}, 401) })
    await start(h)
    expect(h.providers().has("nodul")).toBe(false)
    expect(h.statuses).toEqual([
      expect.objectContaining({ integrationID: "nodul", status: expect.objectContaining({ status: "needs_auth" }) }),
    ])
  })

  test("switching keys swaps the model list", async () => {
    const lists: Record<string, unknown[]> = { "sk-nr-alice": [model("a/one")], "sk-nr-bob": [model("b/two")] }
    const h = harness({ credential: { type: "key", key: "sk-nr-alice" }, router: (key) => json({ data: lists[key] }) })
    await start(h)
    expect(h.providers().get("nodul").models.map((m: any) => m.id)).toEqual(["a/one"])
    await h.switchKey({ type: "key", key: "sk-nr-bob" })
    const nodul = h.providers().get("nodul")
    expect(nodul.models.map((m: any) => m.id)).toEqual(["b/two"])
    expect(nodul.sourceConnection).toMatchObject({ id: "cred_sk-nr-bob" })
  })

  test("removing the key removes the provider", async () => {
    const h = harness({ credential: { type: "key", key: "sk-nr-alice" }, router: () => json({ data: [model("a/one")] }) })
    await start(h)
    await h.switchKey(undefined)
    expect(h.providers().has("nodul")).toBe(false)
  })

  test("a router outage keeps the last list", async () => {
    let up = true
    const h = harness({
      credential: { type: "key", key: "sk-nr-alice" },
      router: () => (up ? json({ data: [model("a/one")] }) : json({}, 503)),
    })
    await start(h)
    up = false
    await h.refreshSameKey()
    const nodul = h.providers().get("nodul")
    expect(nodul.models.map((m: any) => m.id)).toEqual(["a/one"])
    expect(nodul.sourceConnection).toMatchObject({ id: "cred_1" })
  })
})
