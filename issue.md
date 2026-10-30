# Title

Soft navigation waits for the target's in-flight segment prefetch (page head) instead of showing `loading.js` (regression in 16.3.1-canary.16, still in 16.4.3)

---

## Link to the code that reproduces this issue

REPO_URL

## To Reproduce

1. `npm install`, then `npm run build && npm start` (serves on `http://localhost:3100`).
2. In another terminal, run `node measure.mjs 5` (Playwright, Chromium).
   - The script opens `/`, which has a single `<Link href="/target">` with the default prefetch.
   - It waits until the `/_tree` prefetch for `/target` has arrived, then clicks the link while
     the segment-data prefetch for `/target` is still in flight.
   - To make that window deterministic, it delays only non-`/_tree` prefetch requests by 3 s,
     standing in for a slow network or a busy prefetch queue. The navigation request is not delayed.
3. The script prints, per click, the time until the URL changes, until `app/target/loading.js`
   is shown, and until the page content is shown.

`/target` is dynamic (`await connection()` plus a 1.2 s delay) and has its own `loading.js`.
The root layout exports a static `metadata`. There is no other config.

## Current vs. Expected behavior

**Expected** (and what 16.3.8 does): the click commits right away. The URL changes and
`loading.js` is shown within about 70 ms, then the page replaces it once the navigation
response arrives, about 1.2 s later.

**Current** (16.3.1-canary.16 through 16.4.3 and 16.5.0-canary.34): nothing happens on screen
until the delayed **prefetch** resolves. The URL stays on `/`, `loading.js` is never shown,
and the page appears only when the prefetch finishes, even though the navigation response
arrived after about 1.2 s.

Five runs each, `PREFETCH_DELAY_MS=3000`:

| `next`           | URL change (median) | `loading.js` shown | content (median) |
| ---------------- | ------------------- | ------------------ | ---------------- |
| 16.3.8           | 71 ms               | 5/5                | 1242 ms          |
| 16.4.3           | 2748 ms             | 0/5                | 2748 ms          |
| 16.5.0-canary.34 | 2741 ms             | 0/5                | 2741 ms          |

With a 6 s prefetch delay, 16.4.3 commits after about 5.75 s. The wait follows the prefetch,
not the navigation response.

## Provide environment information

```bash
Operating System:
  Platform: darwin
  Arch: arm64
  Version: Darwin Kernel Version 27.0.0
  Available memory (MB): 16384
  Available CPU cores: 12
Binaries:
  Node: 22.18.0
  npm: 11.7.0
  Yarn: 1.22.19
  pnpm: 8.15.9
Relevant Packages:
  next: 16.4.3 // Latest available version is detected (16.4.3).
  eslint-config-next: N/A
  react: 19.3.1
  react-dom: 19.3.1
  typescript: N/A
Next.js Config:
  output: N/A
```

## Which area(s) are affected? (Select all that apply)

Linking and Navigating, Loading UI and Streaming, Metadata

## Which stage(s) are affected? (Select all that apply)

next start (local), Other (Deployed)

## Additional context

**Bisect** (two runs per version):

| `next`           | result                     |
| ---------------- | -------------------------- |
| 16.3.1-canary.15 | good: 102 ms, loading shown |
| 16.3.1-canary.16 | bad: 2739 ms               |

The first bad release is `16.3.1-canary.16`. Its changelog contains the client cache refactors
#96788, #96876, #96877 and #96878 (tree and per-segment prefetches converted to
`NavigationFlightResponse`, unified cache writes) and a React upgrade (#97249).

**Where it waits.** With logging added in `next/dist`, the router takes the soft-navigation
path immediately: the route tree is cached, so it runs `navigateUsingPrefetchedRouteTree` →
`completeSoftNavigation` within a few ms of the click. The commit is then held by the page
head. The head is a separate segment-cache entry that is still `Pending`, because it travels
with the delayed segment prefetch. `Head` in `client/components/app-router.js` returns
`useDeferredValue(head, prefetchHead)`, which here is a pending promise rendered outside any
Suspense boundary, so React suspends the whole transition until the prefetch resolves.

As a control experiment, I patched `Head` to return `null` while its promise is pending. The
same scenario on 16.4.3 then commits in 72 ms (3/3) and shows `loading.js`.

**Impact.** In a real app with many links per page (dozens of prefetches, 4 at a time), a click
in the first seconds after load routinely lands in this window. The link appears to do nothing
until the target's prefetch completes. It reproduces on a fast local machine; it does not need
CPU contention.

**Related:** #100436 ("Link click never commits when the navigation starts during the target's
metadata-only prefetch", 16.2.6). Similar trigger, a click while the target's metadata is
still being prefetched. There the navigation never commits; here it commits only when the
prefetch finishes.
