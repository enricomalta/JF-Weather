import type { GridResponse, TimelinePoint, WeatherData, WeatherTile } from './types'

const API_URL = 'https://api.tomorrow.io/v4/weather/realtime'
const TIMELINE_URL = 'https://api.tomorrow.io/v4/timelines'
const CENTER = { lat: -21.7642, lon: -43.3503 }
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

export async function fetchWeatherGrid(tiles: Array<{ lat: number; lon: number }>): Promise<GridResponse> {
  const apiKey = process.env.TOMORROW_API_KEY
  const now = Date.now()
  if (cachedResponse && now - cachedAt < CACHE_TTL) return cachedResponse
  if (inFlight) return inFlight
  if (!apiKey) return { tiles: tiles.map((tile) => ({ ...tile, data: null, error: 'TOMORROW_API_KEY não configurada' })), timeline: [], timestamp: now, updateTimestamp: now, nextUpdate: now + 300000, status: 'error', message: 'Dados meteorológicos indisponíveis' }

  inFlight = (async () => {
  const results = await Promise.all(
    tiles.map(async (tile): Promise<WeatherTile> => {
      try {
        const payload = await fetchJson(
          `${API_URL}?location=${tile.lat},${tile.lon}&apikey=${encodeURIComponent(apiKey)}&units=metric`,
          { next: { revalidate: 300 } },
        )
        const timestamp = Date.parse(
          payload.data?.time ?? new Date().toISOString(),
        )
        return {
          ...tile,
          data: normalize(payload.data?.values ?? {}, timestamp),
        }
      } catch (error) {
        return {
          ...tile,
          data: null,
          error:
            error instanceof Error
              ? error.message
              : 'Falha ao consultar o serviço',
        }
      }
    }),
  )
  const firstData = results.find((tile) => tile.data)?.data
  if (!firstData) {
    return {
      tiles: results,
      timeline: [],
      timestamp: now,
      updateTimestamp: now,
      nextUpdate: now + 300000,
      status: 'error',
      message: 'Dados meteorológicos indisponíveis',
    }
  }

  let timeline: TimelinePoint[] = []
  try {
    const payload = await fetchJson(TIMELINE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: `${CENTER.lat},${CENTER.lon}`, fields: ['precipitationIntensity', 'precipitationProbability'], timesteps: ['1h'], startTime: 'now', endTime: 'nowPlus12h', units: 'metric', apikey: apiKey }), next: { revalidate: 300 } })
    timeline = (payload.data?.timelines?.[0]?.intervals ?? []).map((item: { startTime: string; values?: Record<string, number> }) => ({ time: Date.parse(item.startTime), precipitation: item.values?.precipitationIntensity ?? 0, probability: item.values?.precipitationProbability ?? 0 }))
  } catch { /* A observação atual continua disponível mesmo sem a previsão. */ }

  const hasErrors = results.some((tile) => !tile.data)
  const response: GridResponse = { tiles: results, timeline, timestamp: now, updateTimestamp: firstData.timestamp, nextUpdate: now + 300000, status: hasErrors ? 'partial' : 'success', message: hasErrors ? 'Alguns pontos não puderam ser consultados' : undefined }
  cachedResponse = response
  cachedAt = now
  return response
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}
