import { Model, Provider } from "@opencode/plugin"

export const PROVIDER_ID = "nodul"
export const PACKAGE = "@opencode/ai/providers/openai-compatible"

/** One entry of the router's `GET /api/v1/models`, as documented at router.nodul.ru/docs/ru/api/models. */
export interface RouterModel {
  readonly id: string
  readonly name?: string
  readonly context_length?: number
  readonly architecture?: { readonly input_modalities?: readonly string[] }
  readonly pricing?: { readonly prompt?: string; readonly completion?: string; readonly input_cache_read?: string }
  readonly top_provider?: { readonly context_length?: number | null; readonly max_completion_tokens?: number | null }
  readonly supported_parameters?: readonly string[]
}

// The router reports documents as `file`; OpenCode calls the same input `pdf`.
const INPUT: Record<string, string> = { text: "text", image: "image", file: "pdf", audio: "audio", video: "video" }
const EFFORTS = ["low", "medium", "high"] as const

/** Per-token price string to a per-million price. The router prices in PnP; they are passed through unconverted. */
function perMillion(value: string | undefined) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : 0
}

function positive(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * Turns the router's model list into OpenCode models. OpenCode is an agent, so only models that support
 * tool calling are kept; an entry that can't be read is skipped instead of failing the whole list.
 */
export function toModels(data: readonly unknown[], baseURL: string): Model.Info[] {
  const providerID = Provider.ID.make(PROVIDER_ID)
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const remote = item as RouterModel
    if (typeof remote.id !== "string" || !remote.id || !remote.supported_parameters?.includes("tools")) return []

    const id = Model.ID.make(remote.id)
    const base = Model.Info.default(providerID, id)
    const context = positive(remote.top_provider?.context_length) ?? positive(remote.context_length) ?? base.limit.context
    const input = [...new Set((remote.architecture?.input_modalities ?? ["text"]).flatMap((x) => INPUT[x] ?? []))]
    const reasoning = remote.supported_parameters.includes("reasoning_effort")

    const model = {
      ...base,
      name: remote.name || remote.id,
      package: PACKAGE,
      settings: { baseURL, provider: PROVIDER_ID },
      capabilities: { tools: true, input: input.length ? input : ["text"], output: ["text"] },
      variants: reasoning
        ? EFFORTS.map((effort) => ({ id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } }))
        : [],
      cost: [
        {
          input: perMillion(remote.pricing?.prompt),
          output: perMillion(remote.pricing?.completion),
          cache: { read: perMillion(remote.pricing?.input_cache_read), write: 0 },
        },
      ],
      limit: { context, output: positive(remote.top_provider?.max_completion_tokens) ?? Math.min(32_000, context) },
    }
    // Money fields are branded numbers in the schema; the brand is type-only.
    return [model as unknown as Model.Info]
  })
}
