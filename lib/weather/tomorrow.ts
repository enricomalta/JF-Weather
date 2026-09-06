import type { GridResponse, TimelinePoint, WeatherData, WeatherTile } from './types'

const API_URL = 'https://api.tomorrow.io/v4/weather/realtime'
const TIMELINE_URL = 'https://api.tomorrow.io/v4/timelines'
const CACHE_TTL = 5 * 60 * 1000
let cachedResponse: GridResponse | null = null
let cachedAt = 0
let inFlight: Promise<GridResponse> | null = null

function normalize(values: Record<string, number>, timestamp: number): WeatherData {
  return { temperature: values.temperature ?? values.temperatureApparent ?? 0, humidity: values.humidity ?? 0, precipitation: values.precipitationIntensity ?? 0, precipitationProbability: values.precipitationProbability ?? 0, windSpeed: values.windSpeed ?? 0, windDirection: values.windDirection ?? 0, cloudCover: values.cloudCover ?? 0, timestamp }
}

async function fetchJson(url: string, init: RequestInit & { next?: { revalidate: number } }) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`Tomorrow.io respondeu ${response.status}`)
  return response.json()
}

function normalizeTimeline(
  intervals: Array<{ startTime?: string; values?: Record<string, number> }>,
): TimelinePoint[] {
  return intervals.map((item, index) => ({
    time:
      Date.parse(item.startTime ?? "") ||
      Math.floor(Date.now() / 3600000) * 3600000 + index * 3600000,
    precipitation: item.values?.precipitationIntensity ?? 0,
    probability: item.values?.precipitationProbability ?? 0,
  }))
}

async function fetchTimeline(lat: number, lon: number, apiKey: string): Promise<TimelinePoint[]> {
  const payload = await fetchJson(TIMELINE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: `${lat},${lon}`, fields: ['precipitationIntensity', 'precipitationProbability'], timesteps: ['1h'], startTime: 'now', endTime: 'nowPlus12h', units: 'metric', apikey: apiKey }),
    next: { revalidate: 300 },
  })
  return normalizeTimeline(payload.data?.timelines?.[0]?.intervals ?? [])
}

export async function fetchWeatherGrid(tiles: Array<{ lat: number; lon: number }>): Promise<GridResponse> {
  const apiKey = process.env.TOMORROW_API_KEY
  const now = Date.now()
  if (cachedResponse && now - cachedAt < CACHE_TTL) return cachedResponse
  if (inFlight) return inFlight
  if (!apiKey) return { tiles: tiles.map((tile) => ({ ...tile, data: null, timeline: [], error: 'TOMORROW_API_KEY não configurada' })), timeline: [], timestamp: now, updateTimestamp: now, nextUpdate: now + 300000, status: 'error', message: 'Dados meteorológicos indisponíveis' }

  inFlight = (async () => {
    const results = await Promise.all(tiles.map(async (tile): Promise<WeatherTile> => {
      try {
        const payload = await fetchJson(`${API_URL}?location=${tile.lat},${tile.lon}&apikey=${encodeURIComponent(apiKey)}&units=metric`, { next: { revalidate: 300 } })
        const timestamp = Date.parse(payload.data?.time ?? new Date().toISOString())
        let timeline: TimelinePoint[] = []
        try { timeline = await fetchTimeline(tile.lat, tile.lon, apiKey) } catch { /* Mantém a observação atual quando a previsão falhar. */ }
        return { ...tile, data: normalize(payload.data?.values ?? {}, timestamp), timeline }
      } catch (error) {
        return { ...tile, data: null, timeline: [], error: error instanceof Error ? error.message : 'Falha ao consultar o serviço' }
      }
    }))
    const firstData = results.find((tile) => tile.data)?.data
    if (!firstData) return { tiles: results, timeline: [], timestamp: now, updateTimestamp: now, nextUpdate: now + 300000, status: 'error', message: 'Dados meteorológicos indisponíveis' }
    const selectedTimeline = results.find((tile) => tile.timeline.length > 0)?.timeline ?? []
    const hasErrors = results.some((tile) => !tile.data)
    const response: GridResponse = { tiles: results, timeline: selectedTimeline, timestamp: now, updateTimestamp: firstData.timestamp, nextUpdate: now + 300000, status: hasErrors ? 'partial' : 'success', message: hasErrors ? 'Alguns pontos não puderam ser consultados' : undefined }
    cachedResponse = response
    cachedAt = now
    return response
  })()
  try { return await inFlight } finally { inFlight = null }
}
