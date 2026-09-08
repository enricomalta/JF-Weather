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

const TIMELINE_URL = "https://api.tomorrow.io/v4/timelines";

const HOURS = 12;

// Limites operacionais definidos para o projeto.
// Mantemos margem abaixo dos limites oficiais da conta.
const MAX_REQUESTS_PER_SECOND = 3;
const MAX_REQUESTS_PER_HOUR_PER_KEY = 20;

// Intervalo mínimo entre requests do scheduler global.
// 3 req/s => ~333ms entre requests.
const REQUEST_INTERVAL_MS = Math.ceil(
  1000 / MAX_REQUESTS_PER_SECOND,
);

const REQUEST_TIMEOUT_MS = 15000;

const TOMORROW_FIELDS = [
  "temperature",
  "temperatureApparent",
  "humidity",
  "dewPoint",
  "precipitationIntensity",
  "precipitationProbability",
  "windSpeed",
  "windDirection",
  "windGust",
  "pressureSurfaceLevel",
  "visibility",
  "cloudCover",
  "weatherCode",
];

interface ApiKeyState {
  key: string;
  index: number;
  requestsThisHour: number;
  hourStartedAt: number;
  lastUsedAt: number;
}

interface TomorrowTimelineResponse {
  data?: {
    timelines?: Array<{
      timestep?: string;
      startTime?: string;
      endTime?: string;
      intervals?: Array<{
        startTime?: string;
        values?: Record<string, number>;
      }>;
    }>;
  };
}

interface TomorrowError extends Error {
  status?: number;
}

function getApiKeys(): string[] {
  const keys = Array.from({ length: 6 }, (_, index) => {
    return process.env[`TOMORROW_API_KEY_${index + 1}`];
  }).filter((key): key is string => Boolean(key?.trim()));

  if (!keys.length) {
    throw new Error(
      "Nenhuma TOMORROW_API_KEY_1..6 foi configurada",
    );
  }

  return keys;
}

function createKeyStates(): ApiKeyState[] {
  return getApiKeys().map((key, index) => ({
    key,
    index: index + 1,
    requestsThisHour: 0,
    hourStartedAt: Date.now(),
    lastUsedAt: 0,
  }));
}

function resetHourlyCounterIfNeeded(state: ApiKeyState) {
  const now = Date.now();

  if (now - state.hourStartedAt >= 60 * 60 * 1000) {
    state.requestsThisHour = 0;
    state.hourStartedAt = now;
  }
}

function createTomorrowError(
  message: string,
  status?: number,
): TomorrowError {
  const error = new Error(message) as TomorrowError;
  error.status = status;
  return error;
}

function normalize(
  values: Record<string, number>,
  timestamp: number,
): WeatherData {
  return {
    temperature: values.temperature ?? 0,
    humidity: values.humidity ?? 0,
    precipitation: values.precipitationIntensity ?? 0,
    precipitationProbability:
      values.precipitationProbability ?? 0,
    windSpeed: values.windSpeed ?? 0,
    windDirection: values.windDirection ?? 0,
    cloudCover: values.cloudCover ?? 0,
    timestamp,
  };
}

function buildTimeline(
  intervals: Array<{
    startTime?: string;
    values?: Record<string, number>;
  }>,
): TimelinePoint[] {
  return intervals
    .slice(0, HOURS)
    .map((item) => ({
      time: Date.parse(item.startTime ?? ""),
      precipitation:
        item.values?.precipitationIntensity ?? 0,
      probability:
        item.values?.precipitationProbability ?? 0,
    }))
    .filter((item) => Number.isFinite(item.time));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestTimeline(
  point: NeighborhoodPoint,
  key: string,
): Promise<TomorrowTimelineResponse> {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(TIMELINE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        location: `${point.lat},${point.lon}`,
        fields: TOMORROW_FIELDS,
        timesteps: ["1h"],
        startTime: "now",
        endTime: "nowPlus12h",
        units: "metric",
        apikey: key,
      }),
    });

    if (!response.ok) {
      throw createTomorrowError(
        `Tomorrow.io respondeu ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as TomorrowTimelineResponse;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw createTomorrowError(
        "Timeout ao consultar Tomorrow.io",
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function selectKey(
  states: ApiKeyState[],
): ApiKeyState | null {
  const available = states
    .map((state) => {
      resetHourlyCounterIfNeeded(state);
      return state;
    })
    .filter(
      (state) =>
        state.requestsThisHour <
        MAX_REQUESTS_PER_HOUR_PER_KEY,
    );

  if (!available.length) {
    return null;
  }

  // Escolhe primeiro a key com menos requests.
  // Em caso de empate, usa a que está há mais tempo sem ser usada.
  available.sort((a, b) => {
    if (a.requestsThisHour !== b.requestsThisHour) {
      return (
        a.requestsThisHour - b.requestsThisHour
      );
    }

    return a.lastUsedAt - b.lastUsedAt;
  });

  return available[0];
}

async function waitForAvailableKey(
  states: ApiKeyState[],
): Promise<ApiKeyState> {
  while (true) {
    const key = selectKey(states);

    if (key) {
      return key;
    }

    const now = Date.now();

    const nextReset = Math.min(
      ...states.map(
        (state) =>
          state.hourStartedAt + 60 * 60 * 1000,
      ),
    );

    const waitTime = Math.max(
      1000,
      nextReset - now,
    );

    await sleep(waitTime);
  }
}

class TomorrowScheduler {
  private lastRequestAt = 0;

  constructor(
    private readonly states: ApiKeyState[],
  ) {}

  async execute(
    point: NeighborhoodPoint,
  ): Promise<WeatherTile> {
    const state = await waitForAvailableKey(
      this.states,
    );

    const now = Date.now();

    const elapsed = now - this.lastRequestAt;

    if (elapsed < REQUEST_INTERVAL_MS) {
      await sleep(
        REQUEST_INTERVAL_MS - elapsed,
      );
    }

    this.lastRequestAt = Date.now();

    state.requestsThisHour += 1;
    state.lastUsedAt = Date.now();

    const response = await requestTimeline(
      point,
      state.key,
    );

    const timelineData =
      response.data?.timelines?.[0];

    const intervals =
      timelineData?.intervals ?? [];

    const firstInterval = intervals[0];

    const timestamp = Date.parse(
      firstInterval?.startTime ??
        new Date().toISOString(),
    );

    return {
      id: point.id,
      name: point.name,
      lat: point.lat,
      lon: point.lon,
      data: normalize(
        firstInterval?.values ?? {},
        timestamp,
      ),
      timeline: buildTimeline(intervals),
    };
  }
}

async function updateFirestore() {
  const states = createKeyStates();

  const scheduler = new TomorrowScheduler(states);

  const points = loadNeighborhoods();

  const results: WeatherTile[] = [];

  for (const point of points) {
    try {
      const tile = await scheduler.execute(point);

      results.push(tile);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Falha ao consultar Tomorrow.io";

      results.push({
        id: point.id,
        name: point.name,
        lat: point.lat,
        lon: point.lon,
        data: null,
        timeline: [],
        error: message,
      });
    }
  }

  const db = weatherDb();

  const batch = db.batch();

  for (const tile of results) {
    batch.set(
      db
        .collection(WEATHER_COLLECTION)
        .doc(String(tile.id)),
      {
        ...tile,
        updatedAt: FieldValue.serverTimestamp(),
      },
    );
  }

  batch.set(
    db
      .collection(WEATHER_META_COLLECTION)
      .doc(WEATHER_META_DOCUMENT),
    {
      updatedAt: FieldValue.serverTimestamp(),
      neighborhoodCount: results.length,
      source: "tomorrow.io",
    },
  );

  await batch.commit();

  const alerts = results
    .filter(
      (tile) =>
        tile.timeline[0]?.precipitation > 0 ||
        (tile.data?.precipitation ?? 0) > 0,
    )
    .map((tile) => tile.name);

  if (alerts.length) {
    await sendDiscordAlert(
      `JF Radar: chuva agora ou na próxima hora em ${alerts.join(
        ", ",
      )}.
       acesse nossa plataforma para mais detalhes: https://jf-weather.vercel.app/`,
    );
  }

  return {
    updated: results.length,
    alerts: alerts.length,
    keys: states.map((state) => ({
      key: state.index,
      requests: state.requestsThisHour,
    })),
  };
}

export async function refreshWeather(
  request: Request,
) {
  if (!refreshSecretIsValid(request)) {
    return new Response("Não autorizado", {
      status: 401,
    });
  }

  try {
    return Response.json(
      await updateFirestore(),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Falha ao atualizar",
      },
      {
        status: 500,
      },
    );
  }
}

export async function readWeather(): Promise<GridResponse> {
  const db = weatherDb();

  let snapshot = await db
    .collection(WEATHER_COLLECTION)
    .get();

  let tiles = snapshot.docs
    .filter(
      (doc) => doc.id !== WEATHER_META_DOCUMENT,
    )
    .map(
      (doc) =>
        serializeFirestore(
          doc.data(),
        ) as WeatherTile,
    );

  if (!tiles.length) {
    await updateFirestore();

    snapshot = await db
      .collection(WEATHER_COLLECTION)
      .get();

    tiles = snapshot.docs
      .filter(
        (doc) => doc.id !== WEATHER_META_DOCUMENT,
      )
      .map(
        (doc) =>
          serializeFirestore(
            doc.data(),
          ) as WeatherTile,
      );
  }

  const meta = await db
    .collection(WEATHER_META_COLLECTION)
    .doc(WEATHER_META_DOCUMENT)
    .get();

  const updateTimestamp = Number(
    meta
      .data()
      ?.updatedAt?.toMillis?.() ??
      Date.now(),
  );

  const timeline =
    tiles.find(
      (tile) => tile.timeline.length,
    )?.timeline ?? [];

  return {
    tiles,
    timeline,
    timestamp: Date.now(),
    updateTimestamp,
    nextUpdate:
      updateTimestamp + 3600000,
    status: tiles.length
      ? tiles.some(
          (tile) => !tile.data,
        )
        ? "partial"
        : "success"
      : "error",
    message: tiles.length
      ? undefined
      : "Nenhuma previsão armazenada",
  };
}