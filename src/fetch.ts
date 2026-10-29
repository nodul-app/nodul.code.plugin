export type FetchResult =
  | { readonly type: "ok"; readonly data: readonly unknown[] }
  /** The router rejected the key: wrong, disabled, or expired. */
  | { readonly type: "unauthorized" }
  /** Network error, timeout, 5xx, or an unreadable body: keep whatever was loaded before. */
  | { readonly type: "unavailable"; readonly reason: string }

export async function fetchModels(
  baseURL: string,
  key: string,
  options: { readonly timeout?: number; readonly fetch?: typeof fetch } = {},
): Promise<FetchResult> {
  const request = options.fetch ?? fetch
  try {
    const response = await request(`${baseURL.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeout ?? 10_000),
    })
    if (response.status === 401 || response.status === 403) return { type: "unauthorized" }
    if (!response.ok) return { type: "unavailable", reason: `HTTP ${response.status}` }
    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body?.data)) return { type: "unavailable", reason: "response has no data array" }
    return { type: "ok", data: body.data }
  } catch (error) {
    return { type: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  }
}
