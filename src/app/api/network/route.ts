export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getNetworkFidsFromHub } from '@/lib/hub'

type Mode = 'followers' | 'following' | 'both'

type NeynarBulkResp = {
  users: Array<{
    fid: number
    username: string
    display_name?: string
    pfp_url?: string
    score?: number
    experimental?: { neynar_user_score?: number }
    profile?: {
      location?: {
        latitude?: number
        longitude?: number
        address?: {
          city?: string
          state?: string
          country?: string
        }
      }
    }
  }>
}

type PinUser = {
  fid: number
  username: string
  display_name?: string
  pfp_url?: string
  score: number
}

type PinPoint = {
  lat: number
  lng: number
  city: string
  count: number
  users: PinUser[]
}

function mustEnv(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function getUserScore(u: NeynarBulkResp['users'][number]): number | null {
  const s =
    typeof u.score === 'number'
      ? u.score
      : typeof u.experimental?.neynar_user_score === 'number'
        ? u.experimental.neynar_user_score
        : null
  return typeof s === 'number' && Number.isFinite(s) ? s : null
}

function formatCity(u: NeynarBulkResp['users'][number]) {
  const a = u.profile?.location?.address
  const parts = [a?.city, a?.state, a?.country].filter(Boolean)
  return parts.length ? parts.join(', ') : 'Unknown'
}

function roundCoord(n: number, decimals = 2) {
  const p = Math.pow(10, decimals)
  return Math.round(n * p) / p
}

async function neynarUserBulk(fids: number[]): Promise<NeynarBulkResp> {
  const apiKey = mustEnv('NEYNAR_API_KEY')

  const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${encodeURIComponent(
    fids.join(',')
  )}`

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 15_000)

  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', api_key: apiKey } as any,
      cache: 'no-store',
      signal: controller.signal,
    })

    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }

    if (!res.ok) {
      const msg = json?.message || json?.error || `Neynar error ${res.status}`
      const err = new Error(
        `[Neynar] ${msg} (${res.status})${text ? ` body=${text.slice(0, 200)}` : ''}`
      )
      ;(err as any).status = res.status
      throw err
    }

    if (!json) throw new Error('[Neynar] Empty/non-JSON response')
    return json as NeynarBulkResp
  } catch (e: any) {
    const cause = e?.name === 'AbortError' ? 'timeout' : e?.message || String(e)
    throw new Error(`[Neynar] fetch failed (${cause})`)
  } finally {
    clearTimeout(t)
  }
}

/**
 * Retry wrapper for Neynar calls:
 * - backs off on 429 + 5xx
 */
async function neynarBulkWithRetry(fids: number[], maxAttempts = 5) {
  let attempt = 0
  while (true) {
    attempt++
    try {
      return await neynarUserBulk(fids)
    } catch (e: any) {
      const msg = e?.message || ''
      const status = e?.status
      const retryable =
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        msg.includes('(timeout)')

      if (!retryable || attempt >= maxAttempts) throw e

      const backoff = Math.min(10_000, 500 * Math.pow(2, attempt - 1))
      // small jitter
      const jitter = Math.floor(Math.random() * 250)
      await sleep(backoff + jitter)
    }
  }
}

/**
 * Simple promise pool with concurrency cap
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let i = 0

  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      results[idx] = await fn(items[idx], idx)
    }
  })

  await Promise.all(workers)
  return results
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)

    const fidStr = searchParams.get('fid')
    const fid = fidStr ? Number(fidStr) : NaN
    if (!fidStr || !Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: 'Missing or invalid fid' }, { status: 400 })
    }

    const mode = (searchParams.get('mode') || 'both') as Mode
    if (mode !== 'followers' && mode !== 'following' && mode !== 'both') {
      return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
    }

    // limitEach:
    // - "all" => paginate fully (bounded by maxEach)
    // - "0" or "-1" => also treated as all
    // - number => capped
    const limitEachRaw = searchParams.get('limitEach') || '200'
    const limitEach =
      limitEachRaw === 'all'
        ? ('all' as const)
        : Number(limitEachRaw)

    // Safety cap per side when doing "all"
    const maxEachParam = Number(searchParams.get('maxEach') || '20000')
    const maxEach = Number.isFinite(maxEachParam)
      ? Math.min(Math.max(maxEachParam, 1000), 100000)
      : 20000

    const minScoreParam = Number(searchParams.get('minScore') || '0.8')
    const minScore = Number.isFinite(minScoreParam) ? minScoreParam : 0.8

    // Tunables for Neynar hydration scaling
    const concurrencyParam = Number(searchParams.get('concurrency') || '4')
    const concurrency = Number.isFinite(concurrencyParam)
      ? Math.min(Math.max(concurrencyParam, 1), 8)
      : 4

    const includeFollowers = mode === 'followers' || mode === 'both'
    const includeFollowing = mode === 'following' || mode === 'both'

    // 1) Hub: get follower +/or following FIDs (free)
    const { followers, following } = await getNetworkFidsFromHub(fid, {
      includeFollowers,
      includeFollowing,
      limitEach: limitEach as any, // number | 'all'
      maxEach,
    })

    // include self so you can always show yourself if you have location/score
    const merged = Array.from(new Set([fid, ...followers, ...following]))

    // 2) Neynar: hydrate users in batches (100 fids per call), in parallel with concurrency cap
    const batches = chunk(merged, 100)

    const bulkResults = await mapPool(batches, concurrency, async (b) => {
      return await neynarBulkWithRetry(b, 5)
    })

    const allUsers: NeynarBulkResp['users'] = []
    for (const r of bulkResults) allUsers.push(...(r.users || []))

    // 3) Filter by score, require lat/lng, then group by rounded coordinates
    let scoredOk = 0
    let missingScore = 0
    let withLocation = 0

    const grouped = new Map<string, PinPoint>()

    for (const u of allUsers) {
      const score = getUserScore(u)
      if (score === null) {
        missingScore++
        continue
      }
      if (score <= minScore) continue
      scoredOk++

      const lat0 = u.profile?.location?.latitude
      const lng0 = u.profile?.location?.longitude
      if (typeof lat0 !== 'number' || typeof lng0 !== 'number') continue

      // basic validation to avoid garbage coords
      if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) continue
      if (lat0 < -90 || lat0 > 90 || lng0 < -180 || lng0 > 180) continue

      withLocation++

      const lat = roundCoord(lat0, 2)
      const lng = roundCoord(lng0, 2)
      const key = `${lat},${lng}`

      const city = formatCity(u)

      const user: PinUser = {
        fid: u.fid,
        username: u.username,
        display_name: u.display_name,
        pfp_url: u.pfp_url,
        score,
      }

      const existing = grouped.get(key)
      if (!existing) {
        grouped.set(key, {
          lat,
          lng,
          city,
          count: 1,
          users: [user],
        })
      } else {
        existing.count += 1
        existing.users.push(user)
        if (existing.city === 'Unknown' && city !== 'Unknown') existing.city = city
      }
    }

    const points: PinPoint[] = Array.from(grouped.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.city.localeCompare(b.city)
    })

    return NextResponse.json({
      fid,
      mode,
      minScore,
      limitEach: limitEachRaw,
      maxEach,
      concurrency,
      followersCount: followers.length,
      followingCount: following.length,
      hydrated: allUsers.length,
      scoredOk,
      missingScore,
      withLocation,
      count: points.length,
      points,
    })
  } catch (e: any) {
    console.error('api/network error:', e)
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 })
  }
}
