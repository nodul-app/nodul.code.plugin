// End-to-end check against a real OpenCode server: loads this plugin from the working tree, points it at a
// mock router, and checks what OpenCode lists for two different keys.
//
//   bun run test/smoke/run.ts            (OPENCODE_BIN overrides the CLI path)
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "../..")
const APP_CLI = "/Applications/OpenCode.app/Contents/Resources/opencode-cli"
const bin = process.env.OPENCODE_BIN ?? ((await Bun.file(APP_CLI).exists()) ? APP_CLI : Bun.which("opencode"))
if (!bin) throw new Error("OpenCode CLI not found: set OPENCODE_BIN")

const WEB_SEARCH = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]
const tools = (id: string) => ({ id, name: id, context_length: 100000, supported_parameters: ["tools"] })
const KEYS: Record<string, unknown[]> = {
  "sk-nr-alice": [tools("anthropic/claude-sonnet-5.5"), tools("ru-2/deepseek-v4.1-flash"), { id: "x/no-tools", supported_parameters: [] }],
  "sk-nr-bob": [tools("z-ai/glm-5.3")],
}

const router = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/api/v1/models") return new Response("not found", { status: 404 })
    const key = request.headers.get("authorization")?.replace(/^Bearer /, "")
    const data = key ? KEYS[key] : Object.values(KEYS).flat()
    return data ? Response.json({ data }) : Response.json({ error: "invalid key" }, { status: 401 })
  },
})

const root = mkdtempSync(path.join(tmpdir(), "nodul-smoke-"))
const dir = (name: string) => {
  const value = path.join(root, name)
  mkdirSync(value, { recursive: true })
  return value
}
const project = dir("project")
// Load a copy with only the published files and no node_modules, as a Git install would: imports of
// @opencode/plugin must then resolve to the copy OpenCode provides.
const plugin = dir("plugin")
const manifest = await Bun.file(path.join(repo, "package.json")).json()
for (const entry of ["package.json", ...manifest.files]) cpSync(path.join(repo, entry), path.join(plugin, entry), { recursive: true })
writeFileSync(
  path.join(dir("config/opencode"), "opencode.json"),
  JSON.stringify({ plugins: [{ package: plugin, options: { baseURL: `${router.url.origin}/api/v1` } }] }),
)

const port = 20000 + Math.floor(Math.random() * 20000)
const server = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: project,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: dir("data"),
    XDG_CACHE_HOME: dir("cache"),
    XDG_STATE_HOME: dir("state"),
    // The bundled models.dev snapshot: a full catalog of providers to hide, without network access.
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  },
  stdout: "pipe",
  stderr: "pipe",
})

let failed = false
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "✔" : "✘"} ${name}${ok || detail === undefined ? "" : `\n    ${JSON.stringify(detail)}`}`)
  if (!ok) failed = true
}

async function readPassword() {
  const reader = server.stdout.getReader()
  let text = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
    const match = text.match(/server password (\S+)/)
    if (match) return match[1]!
  }
  throw new Error(`opencode serve did not start:\n${text}\n${await new Response(server.stderr).text()}`)
}

try {
  const password = await readPassword()
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const api = async (method: string, route: string, body?: unknown) => {
    const url = new URL(route, `http://127.0.0.1:${port}`)
    url.searchParams.set("directory", project)
    const response = await fetch(url, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`)
    const text = await response.text()
    return text ? (JSON.parse(text).data ?? JSON.parse(text)) : undefined
  }
  const waitFor = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, timeout = 60_000) => {
    const deadline = Date.now() + timeout
    let value = await read()
    while (!ok(value) && Date.now() < deadline) {
      await Bun.sleep(500)
      value = await read()
    }
    return value
  }
  const integrations = () => api("GET", "/api/integration").then((list: { id: string }[]) => list.map((i) => i.id).sort())
  const models = () =>
    api("GET", "/api/model").then((list: { providerID: string; id: string }[]) => list.map((m) => `${m.providerID}/${m.id}`).sort())

  const expected = ["nodul", ...WEB_SEARCH].sort()
  const listed = await waitFor(integrations, (ids) => JSON.stringify(ids) === JSON.stringify(expected))
  check("only Nodul and web search integrations are listed", JSON.stringify(listed) === JSON.stringify(expected), listed)
  check("no models before a key is entered", (await models()).length === 0, await models())

  await api("POST", "/api/integration/nodul/connect/key", { key: "sk-nr-alice", label: "alice" })
  const alice = ["nodul/anthropic/claude-sonnet-5.5", "nodul/ru-2/deepseek-v4.1-flash"]
  const aliceModels = await waitFor(models, (ids) => JSON.stringify(ids) === JSON.stringify(alice))
  check("alice sees only her tool-capable models", JSON.stringify(aliceModels) === JSON.stringify(alice), aliceModels)
  const preferred = await api("GET", "/api/model/default")
  check(
    "default model is ru-2/deepseek-v4.1-flash",
    preferred?.providerID === "nodul" && preferred?.id === "ru-2/deepseek-v4.1-flash",
    preferred && { providerID: preferred.providerID, id: preferred.id },
  )

  await api("POST", "/api/integration/nodul/connect/key", { key: "sk-nr-bob", label: "bob" })
  const bob = ["nodul/z-ai/glm-5.3"]
  const bobModels = await waitFor(models, (ids) => JSON.stringify(ids) === JSON.stringify(bob))
  check("switching to bob's key swaps the list", JSON.stringify(bobModels) === JSON.stringify(bob), bobModels)
} catch (error) {
  failed = true
  console.error(error)
} finally {
  server.kill()
  router.stop(true)
  await server.exited
  rmSync(root, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
