/**
 * Shared ACLED API fetch with Redis caching + automatic OAuth token refresh.
 *
 * Three endpoints call ACLED independently (risk-scores, unrest-events,
 * acled-events) with overlapping queries. This shared layer ensures
 * identical queries hit Redis instead of making redundant upstream calls.
 *
 * Token lifecycle:
 *   1. Check Redis for cached OAuth token (key: acled:oauth:token)
 *   2. If missing, exchange ACLED_EMAIL + ACLED_PASSWORD for a new one
 *   3. Cache in Redis for 23 h (token valid 24 h)
 *   4. Falls back to static ACLED_ACCESS_TOKEN env var if credentials missing
 */

declare const process: { env: Record<string, string | undefined> };

import { CHROME_UA } from './constants';
import { cachedFetchJson, getCachedJson, setCachedJson } from './redis';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_OAUTH_URL = 'https://acleddata.com/oauth/token';
const ACLED_CACHE_TTL = 900; // 15 min — matches ACLED rate-limit window
const ACLED_TIMEOUT_MS = 15_000;
const ACLED_TOKEN_REDIS_KEY = 'acled:oauth:token';
const ACLED_TOKEN_TTL = 82_800; // 23 hours (token valid 24 h, refresh 1 h early)

export interface AcledRawEvent {
  event_id_cnty?: string;
  event_type?: string;
  sub_event_type?: string;
  country?: string;
  location?: string;
  latitude?: string;
  longitude?: string;
  event_date?: string;
  fatalities?: string;
  source?: string;
  actor1?: string;
  actor2?: string;
  admin1?: string;
  notes?: string;
  tags?: string;
}

interface FetchAcledOptions {
  eventTypes: string;
  startDate: string;
  endDate: string;
  country?: string;
  limit?: number;
}

let inFlightTokenPromise: Promise<string | null> | null = null;

/**
 * Obtain a valid ACLED Bearer token, refreshing via OAuth if needed.
 * Uses Redis to persist the token across Edge Function invocations.
 */
async function getAcledToken(): Promise<string | null> {
  // 1. Static env var takes priority if set (backwards-compatible)
  const staticToken = process.env.ACLED_ACCESS_TOKEN;
  if (staticToken) return staticToken;

  const email = process.env.ACLED_EMAIL;
  const password = process.env.ACLED_PASSWORD;
  if (!email || !password) return null;

  // 2. Check Redis cache
  const cached = await getCachedJson(ACLED_TOKEN_REDIS_KEY, true);
  if (typeof cached === 'string' && cached.length > 20) return cached;

  // 3. Coalesce concurrent refresh attempts within the same invocation
  if (inFlightTokenPromise) return inFlightTokenPromise;

  inFlightTokenPromise = (async () => {
    try {
      const resp = await fetch(ACLED_OAUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': CHROME_UA,
        },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'acled',
          username: email,
          password: password,
        }),
        signal: AbortSignal.timeout(ACLED_TIMEOUT_MS),
      });

      if (!resp.ok) {
        console.error(`[acled-oauth] Token refresh failed: ${resp.status}`);
        return null;
      }

      const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
      const newToken = data.access_token;
      if (!newToken) {
        console.error('[acled-oauth] No access_token in response');
        return null;
      }

      await setCachedJson(ACLED_TOKEN_REDIS_KEY, newToken, ACLED_TOKEN_TTL);
      console.log('[acled-oauth] Token refreshed, cached for 23h');
      return newToken;
    } catch (err) {
      console.error('[acled-oauth] Token refresh error:', err);
      return null;
    } finally {
      inFlightTokenPromise = null;
    }
  })();

  return inFlightTokenPromise;
}

/**
 * Fetch ACLED events with automatic Redis caching.
 * Cache key is derived from query parameters so identical queries across
 * different handlers share the same cached result.
 */
export async function fetchAcledCached(opts: FetchAcledOptions): Promise<AcledRawEvent[]> {
  const token = await getAcledToken();
  if (!token) return [];

  const cacheKey = `acled:shared:${opts.eventTypes}:${opts.startDate}:${opts.endDate}:${opts.country || 'all'}:${opts.limit || 500}`;
  const result = await cachedFetchJson<AcledRawEvent[]>(cacheKey, ACLED_CACHE_TTL, async () => {
    const params = new URLSearchParams({
      event_type: opts.eventTypes,
      event_date: `${opts.startDate}|${opts.endDate}`,
      event_date_where: 'BETWEEN',
      limit: String(opts.limit || 500),
      _format: 'json',
    });
    if (opts.country) params.set('country', opts.country);

    const resp = await fetch(`${ACLED_API_URL}?${params}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(ACLED_TIMEOUT_MS),
    });

    if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
    const data = (await resp.json()) as { data?: AcledRawEvent[]; message?: string; error?: string };
    if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');

    const events = data.data || [];
    return events.length > 0 ? events : null;
  });
  return result || [];
}
