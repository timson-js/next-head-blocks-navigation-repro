// Measures how long a <Link> click takes to commit when the click happens after the target's
// route tree (`/_tree`) prefetch has arrived but before its segment-data prefetch has.
//
// Usage: start the app (`npm run build && npm start`), then `node measure.mjs [runs]`.
// BASE_URL (default http://localhost:3100) and PREFETCH_DELAY_MS (default 3000) can be overridden.
import { chromium } from "playwright"
import { readFileSync } from "node:fs"

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100"
const RUNS = Number(process.argv[2] ?? 5)
// Simulates a slow network for segment-data prefetches only. The `/_tree` prefetch and the
// navigation request itself are not delayed, so the target's route tree is known at click time.
const PREFETCH_DELAY_MS = Number(process.env.PREFETCH_DELAY_MS ?? 3000)
const nextVersion = JSON.parse(readFileSync(new URL("./node_modules/next/package.json", import.meta.url))).version

const browser = await chromium.launch()
const results = []

for (let run = 1; run <= RUNS; run++) {
  const context = await browser.newContext()
  const page = await context.newPage()

  let treeArrived
  const treeReady = new Promise((resolve) => (treeArrived = resolve))
  page.on("response", async (response) => {
    const url = new URL(response.url())
    const headers = await response.request().allHeaders()
    if (url.pathname === "/target" && headers["next-router-segment-prefetch"] === "/_tree") treeArrived()
  })

  await page.route(
    (url) => url.searchParams.has("_rsc"),
    async (route, request) => {
      const headers = await request.allHeaders()
      const isPrefetch = headers["next-router-prefetch"] === "1"
      const isTree = headers["next-router-segment-prefetch"] === "/_tree"
      if (isPrefetch && !isTree) await new Promise((resolve) => setTimeout(resolve, PREFETCH_DELAY_MS))
      await route.continue().catch(() => {})
    }
  )

  await page.goto(BASE_URL, { waitUntil: "load" })
  await treeReady
  await page.waitForTimeout(300)

  await page.evaluate(() => {
    const t0 = performance.now()
    window.__m = { t0, url: null, loading: null, content: null }
    const tick = () => {
      const m = window.__m
      const now = performance.now() - t0
      if (m.url === null && location.pathname === "/target") m.url = now
      if (m.loading === null && document.getElementById("target-loading")) m.loading = now
      if (m.content === null && document.getElementById("target-content")) m.content = now
      if (m.content === null || m.url === null) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.click("#to-target")
  await page.waitForSelector("#target-content", { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(100)

  const m = await page.evaluate(() => window.__m)
  const round = (v) => (v === null ? null : Math.round(v))
  const row = { run, urlChangeMs: round(m.url), loadingShownMs: round(m.loading), contentMs: round(m.content) }
  results.push(row)
  console.log(JSON.stringify(row))
  await context.close()
}

await browser.close()

const median = (values) => {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}
console.log(
  `next@${nextVersion}: median URL change ${median(results.map((r) => r.urlChangeMs))} ms, ` +
    `loading.tsx shown in ${results.filter((r) => r.loadingShownMs !== null).length}/${RUNS} runs ` +
    `(median ${median(results.map((r) => r.loadingShownMs))} ms), content ${median(results.map((r) => r.contentMs))} ms`
)
