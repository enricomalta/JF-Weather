import {
  FieldValue,
  WEATHER_COLLECTION,
  WEATHER_META_COLLECTION,
  WEATHER_META_DOCUMENT,
  refreshSecretIsValid,
  sendDiscordAlert,
  serializeFirestore,
  weatherDb,
} from "./firebase-admin";
import { loadNeighborhoods, type NeighborhoodPoint } from "./neighborhoods";
import type {
  GridResponse,
  TimelinePoint,
  WeatherData,
  WeatherTile,
} from "./types";

const API_URL = "https://api.tomorrow.io/v4/weather/realtime";
const TIMELINE_URL = "https://api.tomorrow.io/v4/timelines";
const HOURS = 12;

function normalize(
  values: Record<string, number>,
  timestamp: number,
): WeatherData {
  return {
    temperature: values.temperature ?? values.temperatureApparent ?? 0,
    humidity: values.humidity ?? 0,
    precipitation: values.precipitationIntensity ?? 0,
    precipitationProbability: values.precipitationProbability ?? 0,
    windSpeed: values.windSpeed ?? 0,
    windDirection: values.windDirection ?? 0,
    cloudCover: values.cloudCover ?? 0,
    timestamp,
  };
}

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Tomorrow.io respondeu ${response.status}`);
  return response.json();
}

function timeline(
  intervals: Array<{ startTime?: string; values?: Record<string, number> }>,
): TimelinePoint[] {
  return intervals
    .slice(0, HOURS)
    .map((item) => ({
      time: Date.parse(item.startTime ?? ""),
      precipitation: item.values?.precipitationIntensity ?? 0,
      probability: item.values?.precipitationProbability ?? 0,
    }))
    .filter((item) => Number.isFinite(item.time));
}

async function fetchNeighborhood(
  point: NeighborhoodPoint,
  key: string,
): Promise<WeatherTile> {
  const [current, forecast] = await Promise.all([
    request(
      `${API_URL}?location=${point.lat},${point.lon}&apikey=${encodeURIComponent(key)}&units=metric`,
    ),
    request(TIMELINE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: `${point.lat},${point.lon}`,
        fields: ["precipitationIntensity", "precipitationProbability"],
        timesteps: ["1h"],
        startTime: "now",
        endTime: "nowPlus12h",
        units: "metric",
        apikey: key,
      }),
    }),
  ]);
  const timestamp = Date.parse(current.data?.time ?? new Date().toISOString());
  return {
    id: point.id,
    name: point.name,
    lat: point.lat,
    lon: point.lon,
    data: normalize(current.data?.values ?? {}, timestamp),
    timeline: timeline(forecast.data?.timelines?.[0]?.intervals ?? []),
  };
}

async function updateFirestore() {
  const key = process.env.TOMORROW_API_KEY;
  if (!key) throw new Error("TOMORROW_API_KEY não configurada");
  const points = loadNeighborhoods();
  const results = await Promise.all(
    points.map((point) =>
      fetchNeighborhood(point, key).catch((error) => ({
        id: point.id,
        name: point.name,
        lat: point.lat,
        lon: point.lon,
        data: null,
        timeline: [],
        error: error instanceof Error ? error.message : "Falha",
      })),
    ),
  );
  const db = weatherDb();
  const batch = db.batch();
  for (const tile of results)
    batch.set(db.collection(WEATHER_COLLECTION).doc(String(tile.id)), {
      ...tile,
      updatedAt: FieldValue.serverTimestamp(),
    });
  batch.set(db.collection(WEATHER_META_COLLECTION).doc(WEATHER_META_DOCUMENT), {
    updatedAt: FieldValue.serverTimestamp(),
    neighborhoodCount: results.length,
    source: "tomorrow.io",
  });
  await batch.commit();
  const alerts = results
    .filter(
      (tile) =>
        tile.timeline[0]?.precipitation > 0 ||
        (tile.data?.precipitation ?? 0) > 0,
    )
    .map((tile) => tile.name);
  if (alerts.length)
    await sendDiscordAlert(
      `JF Radar: chuva agora ou na próxima hora em ${alerts.join(", ")}.
       acesse nossa plataforma para mais detalhes: https://jf-weather.vercel.app/`,
    );
  return { updated: results.length, alerts: alerts.length };
}

export async function refreshWeather(request: Request) {
  if (!refreshSecretIsValid(request))
    return new Response("Não autorizado", { status: 401 });
  try {
    return Response.json(await updateFirestore());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Falha ao atualizar" },
      { status: 500 },
    );
  }
}

export async function readWeather(): Promise<GridResponse> {
  const db = weatherDb();
  let snapshot = await db.collection(WEATHER_COLLECTION).get();
  let tiles = snapshot.docs
    .filter((doc) => doc.id !== WEATHER_META_DOCUMENT)
    .map((doc) => serializeFirestore(doc.data()) as WeatherTile);
  if (!tiles.length) {
    await updateFirestore();
    snapshot = await db.collection(WEATHER_COLLECTION).get();
    tiles = snapshot.docs
      .filter((doc) => doc.id !== WEATHER_META_DOCUMENT)
      .map((doc) => serializeFirestore(doc.data()) as WeatherTile);
  }
  const meta = await db
    .collection(WEATHER_META_COLLECTION)
    .doc(WEATHER_META_DOCUMENT)
    .get();
  const updateTimestamp = Number(
    meta.data()?.updatedAt?.toMillis?.() ?? Date.now(),
  );
  const timeline = tiles.find((tile) => tile.timeline.length)?.timeline ?? [];
  return {
    tiles,
    timeline,
    timestamp: Date.now(),
    updateTimestamp,
    nextUpdate: updateTimestamp + 3600000,
    status: tiles.length
      ? tiles.some((tile) => !tile.data)
        ? "partial"
        : "success"
      : "error",
    message: tiles.length ? undefined : "Nenhuma previsão armazenada",
  };
}
