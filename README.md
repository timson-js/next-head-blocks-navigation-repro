# Soft navigation waits for the target's segment prefetch instead of showing `loading.js`

Minimal reproduction for a navigation regression first seen in `16.3.1-canary.16` and still
present in `16.4.3` and `16.5.0-canary.34`.

## What it does

Two routes:

- `/` (static) renders a `<Link href="/target">` with the default prefetch.
- `/target` is dynamic (`await connection()` plus a 1.2 s delay) and has its own
  `app/target/loading.js`.

The root layout exports a static `metadata`. There is no other config.

`measure.mjs` (Playwright) loads `/`, waits until the `/_tree` prefetch for `/target` has
arrived, then clicks the link while the **segment-data prefetch** for `/target` is still in
flight. To make that window deterministic, the script delays only prefetch requests that are
not `/_tree` (`Next-Router-Prefetch: 1` without `Next-Router-Segment-Prefetch: /_tree`), by
`PREFETCH_DELAY_MS` (default 3000). This stands in for a slow network or a busy prefetch
queue. The navigation request itself is not delayed.

For each click it records:

- `urlChangeMs` — click until `location.pathname` becomes `/target`;
- `loadingShownMs` — click until `#target-loading` (the `loading.js` fallback) appears;
- `contentMs` — click until `#target-content` appears.

## Steps

```bash
npm install
npx playwright install chromium   # if not installed yet
npm run build && npm start         # serves on http://localhost:3100
node measure.mjs 5                 # in another terminal
```

To compare versions, change `next` in `package.json`, then run `npm install`, rebuild, restart
and measure again.

## Results

Five runs each on macOS (Apple Silicon, Node 22.18), `next build && next start`, Turbopack,
`PREFETCH_DELAY_MS=3000`:

| `next`             | URL change (median) | `loading.js` shown | content (median) |
| ------------------ | ------------------- | ------------------ | ---------------- |
| 16.3.8             | **71 ms**           | 5/5, at 71 ms      | 1242 ms          |
| 16.4.3             | **2748 ms**         | 0/5                | 2748 ms          |
| 16.5.0-canary.34   | **2741 ms**         | 0/5                | 2741 ms          |

With `PREFETCH_DELAY_MS=6000`, 16.4.3 and 16.5.0-canary.34 commit after about 5750 ms. The
navigation waits for the delayed prefetch, even though the navigation response itself
arrived after about 1.2 s.

Bisect, two runs per version:

| `next`              | URL change | `loading.js` |
| ------------------- | ---------- | ------------ |
| 16.3.1-canary.13    | 87 ms      | shown        |
| 16.3.1-canary.15    | 102 ms     | shown        |
| 16.3.1-canary.16    | 2739 ms    | not shown    |
| 16.3.1-canary.17    | 2739 ms    | not shown    |
| 16.4.0-canary.0     | 2766 ms    | not shown    |

The first bad release is **16.3.1-canary.16**. Its changelog includes the client cache
refactors #96788, #96876, #96877 and #96878 (tree and per-segment prefetches converted to
`NavigationFlightResponse`, unified cache writes), plus a React upgrade (#97249).

## Analysis

With router logging added inside `next/dist`, the router on 16.4.3 decides on a soft
navigation immediately: the route tree is cached, so it goes through
`navigateUsingPrefetchedRouteTree` → `completeSoftNavigation` within a few ms of the click.
The commit does not happen, though.

The render tree contains the page **head** (metadata/viewport), which is now its own entry in
the segment cache and is still `Pending`, because it travels with the delayed segment
prefetch. `Head` in `app-router.js` returns `useDeferredValue(head, prefetchHead)`. That
value is a pending promise, and it is rendered **outside any Suspense boundary**, so React
holds the whole transition until the prefetch resolves. The `loading.js` boundary of the
target segment never gets a chance to show.

Control experiment: patch `Head` in the built `next/dist/client/components/app-router.js` to
return `null` while its promise is pending. On 16.4.3 the same scenario then commits in
**72 ms (3/3)** and shows `loading.js`, as 16.3.8 does.

In real apps this shows up as a link that "does nothing" for the duration of a prefetch.
Typically that is a click in the first seconds after page load on a page with many links,
while the prefetch queue (4 concurrent requests) is still draining.

## Related

- [#100436](https://github.com/vercel/next.js/issues/100436) — "Link click never commits
  when the navigation starts during the target's metadata-only prefetch" (16.2.6). Similar
  trigger, a click while the target's metadata is still being prefetched. There the
  navigation never commits; here it commits only when the prefetch finishes.
