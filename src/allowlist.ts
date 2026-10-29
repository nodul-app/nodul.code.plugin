import { PROVIDER_ID } from "./models.ts"

/**
 * Web search integrations built into OpenCode 2.2 (core/src/plugin/websearch). They are tools, not LLM
 * providers, so they stay. Anything else is treated as an LLM provider and hidden: many of them
 * (Copilot, Azure, Neon) register an integration without a provider, so "referenced by a provider"
 * can't tell them apart.
 */
export const WEB_SEARCH = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]

export function keepIntegration(id: string, webSearch: ReadonlySet<string>) {
  return id === PROVIDER_ID || webSearch.has(id)
}

export function keepProvider(id: string) {
  return id === PROVIDER_ID
}

/** The configured default when the key can use it, otherwise the first enabled model. */
export function pickDefault(models: readonly { id: string; enabled: boolean }[], preferred: string) {
  const enabled = models.filter((model) => model.enabled)
  return (enabled.find((model) => model.id === preferred) ?? enabled[0])?.id
}
