import { FieldValue, WEATHER_COLLECTION, WEATHER_META_COLLECTION, WEATHER_META_DOCUMENT, refreshSecretIsValid, sendDiscordAlert, serializeFirestore, weatherDb } from "./firebase-admin"
import { loadNeighborhoods, type NeighborhoodPoint } from "./neighborhoods"
import type { GridResponse, TimelinePoint, WeatherData, WeatherTile } from "./types"

const TIMELINE_URL = "https://api.tomorrow.io/v4/timelines"
const HOURS = 12
const MAX_REQUESTS_PER_SECOND = 3
const MAX_REQUESTS_PER_HOUR = 25
const MAX_REQUESTS_PER_DAY = 500
const REQUEST_DELAY_MS = Math.ceil(1000 / MAX_REQUESTS_PER_SECOND)
const RATE_LIMIT_ERROR = "Limite do Tomorrow.io atingido"

function normalize(values: Record<string, number>, timestamp: number): WeatherData {
  return { temperature: values.temperature ?? values.temperatureApparent ?? 0, humidity: values.humidity ?? 0, precipitation: values.precipitationIntensity ?? 0, precipitationProbability: values.precipitationProbability ?? 0, windSpeed: values.windSpeed ?? 0, windDirection: values.windDirection ?? 0, cloudCover: values.cloudCover ?? 0, timestamp }
}

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (response.ok) return response.json()
  if (response.status === 429) throw new Error(RATE_LIMIT_ERROR)
  throw new Error(`Tomorrow.io respondeu ${response.status}`)
}

function timeline(intervals: Array<{ startTime?: string; values?: Record<string, number> }>): TimelinePoint[] {
  return intervals.slice(0, HOURS).map((item) => ({ time: Date.parse(item.startTime ?? ""), precipitation: item.values?.precipitationIntensity ?? 0, probability: item.values?.precipitationProbability ?? 0 })).filter((item) => Number.isFinite(item.time))
}

async function fetchNeighborhood(point: NeighborhoodPoint, key: string): Promise<WeatherTile> {
  const forecast = await request(TIMELINE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: `${point.lat},${point.lon}`,
      fields: ["temperature", "humidity", "precipitationIntensity", "precipitationProbability", "windSpeed", "windDirection", "cloudCover"],
      timesteps: ["current", "1h"],
      startTime: "now",
      endTime: "nowPlus12h",
      units: "metric",
      apikey: key,
    }),
  })
  const source = forecast.data?.timelines?.[0]
  const intervals = source?.intervals ?? []
  const current = intervals[0]
  const timestamp = Date.parse(current?.startTime ?? new Date().toISOString())
  return { id: point.id, name: point.name, lat: point.lat, lon: point.lon, data: normalize(current?.values ?? {}, timestamp), timeline: timeline(intervals.slice(1)) }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function updateFirestore() {
  const key = process.env.TOMORROW_API_KEY
  if (!key) throw new Error("TOMORROW_API_KEY não configurada")
  const points = loadNeighborhoods()
  const db = weatherDb()
  const previous = await db.collection(WEATHER_COLLECTION).get()
  const previousById = new Map(previous.docs.map((doc) => [doc.id, serializeFirestore(doc.data()) as WeatherTile]))
  const metaRef = db.collection(WEATHER_META_COLLECTION).doc(WEATHER_META_DOCUMENT)
  const metaSnapshot = await metaRef.get()
  const meta = metaSnapshot.data() ?? {}
  const now = Date.now()
  const timestampMillis = (value: unknown) => {
    if (typeof value === "number") return value
    if (value && typeof (value as { toMillis?: () => number }).toMillis === "function") return (value as { toMillis: () => number }).toMillis()
    return 0
  }
  const hourStartedAt = timestampMillis(meta.hourStartedAt)
  const dayStartedAt = timestampMillis(meta.dayStartedAt)
  const hourRequests = hourStartedAt && now - hourStartedAt < 3600000 ? Number(meta.hourRequests ?? 0) : 0
  const dayRequests = dayStartedAt && now - dayStartedAt < 86400000 ? Number(meta.dayRequests ?? 0) : 0
  const cursor = Number(meta.cursor ?? 0) % Math.max(points.length, 1)
  const requestBudget = Math.min(MAX_REQUESTS_PER_HOUR - hourRequests, MAX_REQUESTS_PER_DAY - dayRequests)
  const selectedPoints = requestBudget > 0 ? Array.from({ length: Math.min(requestBudget, points.length) }, (_, index) => points[(cursor + index) % points.length]) : []
  const resultsById = new Map(previousById)
  let failed = 0
  let requests = 0

  for (const point of selectedPoints) {
    try {
      resultsById.set(String(point.id), await fetchNeighborhood(point, key))
    } catch (error) {
      failed += 1
      const previousTile = previousById.get(String(point.id))
      if (previousTile) resultsById.set(String(point.id), { ...previousTile, error: error instanceof Error ? error.message : "Falha" })
    }
    requests += 1
    if (requests < selectedPoints.length) await wait(REQUEST_DELAY_MS)
  }

  const results = points.map((point) => resultsById.get(String(point.id)) ?? { id: point.id, name: point.name, lat: point.lat, lon: point.lon, data: null, timeline: [], error: "Aguardando atualização" })

  const batch = db.batch()
  for (const tile of results) batch.set(db.collection(WEATHER_COLLECTION).doc(String(tile.id)), { ...tile, updatedAt: FieldValue.serverTimestamp() })
  batch.set(metaRef, {
    updatedAt: FieldValue.serverTimestamp(),
    attemptedAt: FieldValue.serverTimestamp(),
    neighborhoodCount: results.length,
    failedCount: failed,
    source: "tomorrow.io",
    cursor: (cursor + requests) % Math.max(points.length, 1),
    hourStartedAt: hourStartedAt && now - hourStartedAt < 3600000 ? hourStartedAt : now,
    dayStartedAt: dayStartedAt && now - dayStartedAt < 86400000 ? dayStartedAt : now,
    hourRequests: hourRequests + requests,
    dayRequests: dayRequests + requests,
    rateLimit: { requestsPerSecond: MAX_REQUESTS_PER_SECOND, requestsPerHour: MAX_REQUESTS_PER_HOUR, requestsPerDay: MAX_REQUESTS_PER_DAY },
    rateLimited: failed > 0 && results.some((tile) => tile.error === RATE_LIMIT_ERROR),
  })
  await batch.commit()
  const alerts = results.filter((tile) => tile.timeline[0]?.precipitation > 0 || (tile.data?.precipitation ?? 0) > 0).map((tile) => tile.name)
  if (alerts.length) await sendDiscordAlert(`JF Radar: chuva agora ou na próxima hora em ${alerts.join(", ")}.`)
  return { updated: results.length, alerts: alerts.length }
}

export async function refreshWeather(request: Request) {
  if (!refreshSecretIsValid(request)) return new Response("Não autorizado", { status: 401 })
  try { return Response.json(await updateFirestore()) } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha ao atualizar" }, { status: 500 }) }
}

export async function readWeather(): Promise<GridResponse> {
  const db = weatherDb()
  let snapshot = await db.collection(WEATHER_COLLECTION).get()
  let tiles = snapshot.docs.filter((doc) => doc.id !== WEATHER_META_DOCUMENT).map((doc) => serializeFirestore(doc.data()) as WeatherTile)
  if (!tiles.length) {
    await updateFirestore()
    snapshot = await db.collection(WEATHER_COLLECTION).get()
    tiles = snapshot.docs.filter((doc) => doc.id !== WEATHER_META_DOCUMENT).map((doc) => serializeFirestore(doc.data()) as WeatherTile)
  }
  const meta = await db.collection(WEATHER_META_COLLECTION).doc(WEATHER_META_DOCUMENT).get()
  const updateTimestamp = Number(meta.data()?.updatedAt?.toMillis?.() ?? Date.now())
  const timeline = tiles.find((tile) => tile.timeline.length)?.timeline ?? []
  return { tiles, timeline, timestamp: Date.now(), updateTimestamp, nextUpdate: updateTimestamp + 3600000, status: tiles.length ? (tiles.some((tile) => !tile.data) ? "partial" : "success") : "error", message: tiles.length ? undefined : "Nenhuma previsão armazenada" }
}
