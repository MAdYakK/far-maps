// src/lib/hub.ts

type HubLinkMessage = {
  data?: {
    fid?: number // source fid (the follower / the one doing the follow)
    linkBody?: {
      type?: string // "follow"
      targetFid?: number // the fid being followed
    }
  }
}

type HubLinksResponse = {
  messages?: HubLinkMessage[]
  nextPageToken?: string // empty/undefined when done
}

function mustEnv(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Fetch JSON from hub with backoff for 429 + transient errors.
 * This is where we slow down / avoid pinata rate limits.
 */
async function fetchHubJson(url: string, opts?: { attempts?: number }): Promise<any> {
  const attempts = Math.max(1, Math.min(opts?.attempts ?? 6, 12))

  let lastText = ''
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { cache: 'no-store' }).catch((e: any) => {
      // network error
      return null as any
    })

    if (!res) {
      const jitter = Math.floor(Math.random() * 250)
      await sleep(300 * Math.pow(2, i) + jitter)
      continue
    }

    // If rate-limited, respect Retry-After (seconds) if provided.
    if (res.status === 429) {
      const ra = res.headers.get('retry-after')
      const raMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : 0
      const backoff = Math.min(15_000, 500 * Math.pow(2, i))
      const jitter = Math.floor(Math.random() * 350)
      await sleep(Math.max(raMs, backoff) + jitter)
      continue
    }

    const text = await res.text()
    lastText = text

    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }

    if (!res.ok) {
      const msg = json?.message || json?.error || `Hub error ${res.status}`
      // Retry 5xx a few times
      if (res.status >= 500 && i < attempts - 1) {
        const jitter = Math.floor(Math.random() * 250)
        await sleep(300 * Math.pow(2, i) + jitter)
        continue
      }
      throw new Error(`${msg}${text ? ` — ${text.slice(0, 200)}` : ''}`)
    }

    if (!json) throw new Error('Hub returned empty or non-JSON response')
    return json
  }

  throw new Error(
    `Hub fetch failed after retries${lastText ? ` — ${lastText.slice(0, 200)}` : ''}`
  )
}

async function* paginateLinks(
  urlBase: string,
  opts?: { pageDelayMs?: number; maxPages?: number }
) {
  let pageToken: string | undefined = undefined
  const pageDelayMs = Math.max(0, Math.min(opts?.pageDelayMs ?? 125, 2000))
  const maxPages = Math.max(1, Math.min(opts?.maxPages ?? 200, 2000))

  let pages = 0

  while (true) {
    pages++
    if (pages > maxPages) break

    const url =
      pageToken && pageToken.length
        ? `${urlBase}&pageToken=${encodeURIComponent(pageToken)}`
        : urlBase

    const json = (await fetchHubJson(url)) as HubLinksResponse

    const msgs = Array.isArray(json.messages) ? json.messages : []
    for (const m of msgs) yield m

    const next = json.nextPageToken
    if (!next) break
    pageToken = next

    // ✅ pace hub pagination to avoid 429s
    if (pageDelayMs) await sleep(pageDelayMs)
  }
}

type HubOpts = {
  includeFollowers?: boolean
  includeFollowing?: boolean

  /**
   * Per-side cap. Use:
   *  - number (e.g. 500, 2000)
   *  - "all" to paginate until done (bounded by maxEach safety cap)
   *  - 0 or negative to mean "all"
   */
  limitEach?: number | 'all'

  /**
   * Safety cap when limitEach is "all"/0.
   * Prevents accidentally pulling an extreme amount in one request.
   */
  maxEach?: number

  /**
   * How hard to hit the hub. Lower = fewer 429s.
   */
  pageSize?: number

  /**
   * Delay between hub pages.
   */
  pageDelayMs?: number

  /**
   * Extra safety to prevent infinite scans.
   */
  maxPages?: number
}

export async function getNetworkFidsFromHub(
  fid: number,
  opts?: HubOpts
): Promise<{ followers: number[]; following: number[] }> {
  const hub = mustEnv('FARCASTER_HUB_URL').replace(/\/+$/, '')
  const includeFollowers = opts?.includeFollowers ?? true
  const includeFollowing = opts?.includeFollowing ?? true

  const maxEach = Math.min(Math.max(opts?.maxEach ?? 5000, 200), 100000)

  const rawLimit = opts?.limitEach ?? 500
  const isAll = rawLimit === 'all' || (typeof rawLimit === 'number' && rawLimit <= 0)

  const limitEach = isAll ? maxEach : Math.min(Math.max(Number(rawLimit) || 500, 50), maxEach)

  const pageSize = Math.min(Math.max(opts?.pageSize ?? 50, 10), 100) // ✅ smaller page size helps rate limits
  const pageDelayMs = Math.min(Math.max(opts?.pageDelayMs ?? 125, 0), 2000)
  const maxPages = Math.min(Math.max(opts?.maxPages ?? 200, 1), 2000)

  const followers: number[] = []
  const following: number[] = []

  // following = linksByFid (source fid -> many targetFid)
  if (includeFollowing) {
    const base =
      `${hub}/v1/linksByFid` +
      `?fid=${encodeURIComponent(fid)}` +
      `&link_type=follow` +
      `&pageSize=${encodeURIComponent(pageSize)}`

    for await (const m of paginateLinks(base, { pageDelayMs, maxPages })) {
      const target = m?.data?.linkBody?.targetFid
      if (typeof target === 'number') {
        following.push(target)
        if (following.length >= limitEach) break
      }
    }
  }

  // followers = linksByTargetFid (many source fid -> target_fid)
  if (includeFollowers) {
    const base =
      `${hub}/v1/linksByTargetFid` +
      `?target_fid=${encodeURIComponent(fid)}` +
      `&link_type=follow` +
      `&pageSize=${encodeURIComponent(pageSize)}`

    for await (const m of paginateLinks(base, { pageDelayMs, maxPages })) {
      const source = m?.data?.fid
      if (typeof source === 'number') {
        followers.push(source)
        if (followers.length >= limitEach) break
      }
    }
  }

  return {
    followers: Array.from(new Set(followers)),
    following: Array.from(new Set(following)),
  }
}
