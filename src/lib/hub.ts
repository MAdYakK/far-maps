// lib/hub.ts

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

async function fetchHubJson(url: string): Promise<any> {
  const res = await fetch(url, { cache: 'no-store' })

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || `Hub error ${res.status}`
    throw new Error(`${msg}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  if (!json) throw new Error('Hub returned empty or non-JSON response')
  return json
}

async function* paginateLinks(urlBase: string) {
  let pageToken: string | undefined = undefined

  while (true) {
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
  }
}

type HubOpts = {
  includeFollowers?: boolean
  includeFollowing?: boolean

  /**
   * Per-side cap. Use:
   *  - number (e.g. 500, 2000, 10000)
   *  - "all" to paginate until done (bounded by maxEach safety cap)
   *  - 0 or negative to mean "all"
   */
  limitEach?: number | 'all'

  /**
   * Safety cap when limitEach is "all"/0.
   * Prevents accidentally pulling an extreme amount in one request.
   */
  maxEach?: number
}

export async function getNetworkFidsFromHub(
  fid: number,
  opts?: HubOpts
): Promise<{ followers: number[]; following: number[] }> {
  const hub = mustEnv('FARCASTER_HUB_URL').replace(/\/+$/, '')
  const includeFollowers = opts?.includeFollowers ?? true
  const includeFollowing = opts?.includeFollowing ?? true

  const maxEach = Math.min(Math.max(opts?.maxEach ?? 20000, 1000), 100000)

  const rawLimit = opts?.limitEach ?? 500
  const isAll =
    rawLimit === 'all' || (typeof rawLimit === 'number' && rawLimit <= 0)

  // If not "all", clamp to something reasonable but allow larger than before.
  const limitEach = isAll
    ? maxEach
    : Math.min(Math.max(Number(rawLimit) || 500, 50), maxEach)

  const followers: number[] = []
  const following: number[] = []

  // following = linksByFid (source fid -> many targetFid)
  if (includeFollowing) {
    const base =
      `${hub}/v1/linksByFid` +
      `?fid=${encodeURIComponent(fid)}` +
      `&link_type=follow` +
      `&pageSize=100`

    for await (const m of paginateLinks(base)) {
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
      `&pageSize=100`

    for await (const m of paginateLinks(base)) {
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
