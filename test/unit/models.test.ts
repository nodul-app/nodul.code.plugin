import { describe, expect, test } from "bun:test"
import { pickDefault } from "../../src/allowlist.ts"
import { fetchModels } from "../../src/fetch.ts"
import { toModels } from "../../src/models.ts"

const BASE = "https://router.nodul.ru/api/v1"

const remote = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name ${id}`,
  context_length: 131072,
  architecture: { input_modalities: ["text", "image", "file"] },
  pricing: { prompt: "0.0000039", completion: "0.0000065", input_cache_read: "0" },
  top_provider: { context_length: 1048576, max_completion_tokens: 393216 },
  supported_parameters: ["tools", "max_tokens", "reasoning_effort"],
  ...extra,
})

describe("toModels", () => {
  test("keeps only models with tool calling and skips unreadable entries", () => {
    const models = toModels(
      [
        remote("a/with-tools"),
        remote("a/no-tools", { supported_parameters: ["max_tokens"] }),
        null,
        { name: "no id" },
        "garbage",
      ],
      BASE,
    )
    expect(models.map((m) => String(m.id))).toEqual(["a/with-tools"])
  })

  test("maps limits, inputs, PnP prices, variants and the openai-compatible route", () => {
    const [model] = toModels([remote("ru-2/deepseek-v4.1-flash")], BASE)
    expect(model).toMatchObject({
      id: "ru-2/deepseek-v4.1-flash",
      modelID: "ru-2/deepseek-v4.1-flash",
      providerID: "nodul",
      // The name already mentions the region, so no suffix is added.
      name: "Name ru-2/deepseek-v4.1-flash",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: BASE, provider: "nodul" },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      limit: { context: 1048576, output: 393216 },
      enabled: true,
    })
    expect(model!.cost[0]!.input).toBeCloseTo(3.9)
    expect(model!.cost[0]!.output).toBeCloseTo(6.5)
    expect(model!.variants.map((v) => String(v.id))).toEqual(["low", "medium", "high"])
  })

  test("marks Russia-region models with their prefix", () => {
    const names = toModels(
      [
        remote("ru-1/deepseek-ai/DeepSeek-V4-Pro", { name: "DeepSeek-V4-Pro" }),
        remote("ru-2/deepseek-v4.1-flash", { name: "DeepSeek V4.1 Flash" }),
        remote("deepseek/deepseek-v4.1-flash", { name: "DeepSeek: DeepSeek V4.1 Flash" }),
        remote("ru-1/x", { name: "" }),
      ],
      BASE,
    ).map((m) => m.name)
    expect(names).toEqual([
      "DeepSeek-V4-Pro · ru-1",
      "DeepSeek V4.1 Flash · ru-2",
      "DeepSeek: DeepSeek V4.1 Flash",
      "ru-1/x",
    ])
  })

  test("falls back when the router omits limits", () => {
    const [model] = toModels(
      [remote("a/b", { top_provider: {}, context_length: 20000, architecture: undefined, supported_parameters: ["tools"] })],
      BASE,
    )
    expect(model!.limit).toEqual({ context: 20000, output: 20000 })
    expect(model!.capabilities.input).toEqual(["text"])
    expect(model!.variants).toEqual([])
  })
})

describe("pickDefault", () => {
  const models = [
    { id: "a", enabled: false },
    { id: "b", enabled: true },
    { id: "ru-2/deepseek-v4.1-flash", enabled: true },
  ]
  test("uses the preferred model when the key has it", () => {
    expect(pickDefault(models, "ru-2/deepseek-v4.1-flash")).toBe("ru-2/deepseek-v4.1-flash")
  })
  test("falls back to the first enabled model", () => {
    expect(pickDefault(models, "missing")).toBe("b")
    expect(pickDefault([], "missing")).toBeUndefined()
  })
})

describe("fetchModels", () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  test("sends the key and returns the data array", async () => {
    let seen: Request | undefined
    const result = await fetchModels(`${BASE}/`, "sk-nr-test", {
      fetch: (async (url: string, init: RequestInit) => {
        seen = new Request(url, init)
        return new Response(JSON.stringify({ data: [1, 2] }))
      }) as unknown as typeof fetch,
    })
    expect(result).toEqual({ type: "ok", data: [1, 2] })
    expect(seen!.url).toBe(`${BASE}/models`)
    expect(seen!.headers.get("authorization")).toBe("Bearer sk-nr-test")
  })

  test("reports a rejected key", async () => {
    expect(await fetchModels(BASE, "k", { fetch: respond(401, {}) })).toEqual({ type: "unauthorized" })
  })

  test("treats server errors, bad bodies and network failures as unavailable", async () => {
    expect((await fetchModels(BASE, "k", { fetch: respond(502, {}) })).type).toBe("unavailable")
    expect((await fetchModels(BASE, "k", { fetch: respond(200, { nope: 1 }) })).type).toBe("unavailable")
    const offline = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    expect(await fetchModels(BASE, "k", { fetch: offline })).toEqual({ type: "unavailable", reason: "fetch failed" })
  })
})
