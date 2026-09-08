import {
  FieldValue,
  WEATHER_COLLECTION,
  WEATHER_META_COLLECTION,
  WEATHER_META_DOCUMENT,
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

// Cada API key pode fazer no máximo 3 requests por segundo.
const MAX_REQUESTS_PER_SECOND_PER_KEY = 3;

// Limite operacional definido para o projeto.
const MAX_REQUESTS_PER_HOUR_PER_KEY = 20;

// 334 ms garante <= 3 requests/s por key,
// mantendo uma pequena margem de segurança.
const REQUEST_INTERVAL_MS = 334;

const REQUEST_TIMEOUT_MS = 15000;

const EXPECTED_API_KEYS = 6;

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
  const keys = Array.from(
    { length: EXPECTED_API_KEYS },
    (_, index) => {
      const key =
        process.env[`TOMORROW_API_KEY_${index + 1}`];

      return key?.trim() || null;
    },
  );

  const missing = keys
    .map((key, index) =>
      key ? null : `TOMORROW_API_KEY_${index + 1}`,
    )
    .filter((name): name is string => Boolean(name));

  if (missing.length) {
    throw new Error(
      `Variáveis do Tomorrow.io ausentes: ${missing.join(", ")}`,
    );
  }

  return keys as string[];
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

function resetHourlyCounterIfNeeded(
  state: ApiKeyState,
) {
  const now = Date.now();

  if (
    now - state.hourStartedAt >=
    60 * 60 * 1000
  ) {
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
    precipitation:
      values.precipitationIntensity ?? 0,
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
      time: Date.parse(
        item.startTime ?? "",
      ),
      precipitation:
        item.values?.precipitationIntensity ?? 0,
      probability:
        item.values?.precipitationProbability ?? 0,
    }))
    .filter((item) =>
      Number.isFinite(item.time),
    );
}

function sleep(
  ms: number,
): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
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
    const response = await fetch(
      TIMELINE_URL,
      {
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
      },
    );

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

class ApiKeyWorker {
  private lastRequestAt = 0;

  constructor(
    private readonly state: ApiKeyState,
  ) {}

  get keyIndex() {
    return this.state.index;
  }

  async execute(
    point: NeighborhoodPoint,
  ): Promise<WeatherTile> {
    resetHourlyCounterIfNeeded(
      this.state,
    );

    if (
      this.state.requestsThisHour >=
      MAX_REQUESTS_PER_HOUR_PER_KEY
    ) {
      throw new Error(
        `Key ${this.state.index} atingiu o limite operacional de ${MAX_REQUESTS_PER_HOUR_PER_KEY} requests/hora`,
      );
    }

    const now = Date.now();

    const elapsed =
      now - this.lastRequestAt;

    if (
      elapsed < REQUEST_INTERVAL_MS
    ) {
      await sleep(
        REQUEST_INTERVAL_MS - elapsed,
      );
    }

    this.lastRequestAt = Date.now();

    this.state.requestsThisHour += 1;
    this.state.lastUsedAt = Date.now();

    console.log(
      `[Tomorrow.io] Key ${this.state.index} → bairro ${point.id} (${this.state.requestsThisHour}/${MAX_REQUESTS_PER_HOUR_PER_KEY})`,
    );

    const response =
      await requestTimeline(
        point,
        this.state.key,
      );

    const timelineData =
      response.data?.timelines?.[0];

    const intervals =
      timelineData?.intervals ?? [];

    if (!intervals.length) {
      throw createTomorrowError(
        "Tomorrow.io não retornou intervalos para o bairro",
      );
    }

    const firstInterval =
      intervals[0];

    const timestamp = Date.parse(
      firstInterval.startTime ??
        new Date().toISOString(),
    );

    return {
      id: point.id,
      name: point.name,
      lat: point.lat,
      lon: point.lon,
      data: normalize(
        firstInterval.values ?? {},
        timestamp,
      ),
      timeline:
        buildTimeline(intervals),
    };
  }
}

function distributeNeighborhoods(
  points: NeighborhoodPoint[],
  states: ApiKeyState[],
): NeighborhoodPoint[][] {
  const groups = states.map(
    () => [] as NeighborhoodPoint[],
  );

  points.forEach((point, index) => {
    const groupIndex =
      index % states.length;

    groups[groupIndex].push(point);
  });

  return groups;
}

async function processKeyGroup(
  worker: ApiKeyWorker,
  points: NeighborhoodPoint[],
): Promise<WeatherTile[]> {
  const results: WeatherTile[] = [];

  for (const point of points) {
    try {
      const tile =
        await worker.execute(point);

      results.push(tile);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Falha ao consultar Tomorrow.io";

      console.error(
        `[Tomorrow.io] Key ${worker.keyIndex} falhou no bairro ${point.id}: ${message}`,
      );

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

  return results;
}

async function saveResults(
  results: WeatherTile[],
) {
  const db = weatherDb();

  const batch = db.batch();

  for (const tile of results) {
    batch.set(
      db
        .collection(
          WEATHER_COLLECTION,
        )
        .doc(String(tile.id)),
      {
        ...tile,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
    );
  }

  batch.set(
    db
      .collection(
        WEATHER_META_COLLECTION,
      )
      .doc(WEATHER_META_DOCUMENT),
    {
      updatedAt:
        FieldValue.serverTimestamp(),
      neighborhoodCount:
        results.length,
      source: "tomorrow.io",
    },
  );

  await batch.commit();
}

async function sendRainAlerts(
  results: WeatherTile[],
) {
  const alerts = results
    .filter(
      (tile) =>
        tile.timeline[0]
          ?.precipitation > 0 ||
        (tile.data?.precipitation ??
          0) > 0,
    )
    .map((tile) => tile.name);

  if (!alerts.length) {
    return 0;
  }

  await sendDiscordAlert(
    `JF Radar: chuva agora ou na próxima hora em ${alerts.join(
      ", ",
    )}.
accesse nossa plataforma para mais detalhes: https://jf-weather.vercel.app/`,
  );

  return alerts.length;
}

export async function runWeatherUpdate() {
  const startedAt = Date.now();

  console.log(
    "[Weather Worker] Iniciando atualização meteorológica...",
  );

  const states =
    createKeyStates();

  const points =
    loadNeighborhoods();

  console.log(
    `[Weather Worker] ${points.length} bairros encontrados.`,
  );

  console.log(
    `[Weather Worker] ${states.length} keys disponíveis.`,
  );

  const groups =
    distributeNeighborhoods(
      points,
      states,
    );

  groups.forEach(
    (group, index) => {
      console.log(
        `[Weather Worker] Key ${index + 1}: ${group.length} bairros`,
      );
    },
  );

  const workers = states.map(
    (state) =>
      new ApiKeyWorker(state),
  );

  /*
   * IMPORTANTE:
   *
   * Os 6 grupos começam simultaneamente.
   *
   * Cada grupo possui seu próprio scheduler
   * de 3 requests/s.
   *
   * Portanto:
   *
   * Key 1 → 3 req/s
   * Key 2 → 3 req/s
   * Key 3 → 3 req/s
   * Key 4 → 3 req/s
   * Key 5 → 3 req/s
   * Key 6 → 3 req/s
   *
   * Máximo teórico combinado:
   * 18 req/s.
   */
  const groupedResults =
    await Promise.all(
      workers.map(
        (worker, index) =>
          processKeyGroup(
            worker,
            groups[index],
          ),
      ),
    );

  const results =
    groupedResults.flat();

  await saveResults(results);

  const alerts =
    await sendRainAlerts(
      results,
    );

  const successful =
    results.filter(
      (tile) => tile.data !== null,
    ).length;

  const failed =
    results.length - successful;

  const duration =
    Date.now() - startedAt;

  const keyStats =
    states.map((state) => ({
      key: state.index,
      requests:
        state.requestsThisHour,
    }));

  console.log(
    "[Weather Worker] Atualização concluída.",
  );

  console.log(
    `[Weather Worker] Sucesso: ${successful}/${results.length}`,
  );

  console.log(
    `[Weather Worker] Falhas: ${failed}`,
  );

  console.log(
    `[Weather Worker] Duração: ${duration}ms`,
  );

  console.log(
    "[Weather Worker] Uso das keys:",
    keyStats,
  );

  return {
    updated: successful,
    failed,
    alerts,
    duration,
    keys: keyStats,
  };
}

export async function refreshWeather(
  request: Request,
) {
  if (
    !(
      request.headers.get(
        "authorization",
      ) &&
      request.headers.get(
        "authorization",
      ) ===
        `Bearer ${process.env.WEATHER_REFRESH_SECRET}`
    )
  ) {
    return new Response(
      "Não autorizado",
      {
        status: 401,
      },
    );
  }

  try {
    return Response.json(
      await runWeatherUpdate(),
    );
  } catch (error) {
    console.error(
      "[Weather Worker] Erro:",
      error,
    );

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

  let snapshot =
    await db
      .collection(
        WEATHER_COLLECTION,
      )
      .get();

  let tiles =
    snapshot.docs
      .filter(
        (doc) =>
          doc.id !==
          WEATHER_META_DOCUMENT,
      )
      .map(
        (doc) =>
          serializeFirestore(
            doc.data(),
          ) as WeatherTile,
      );

  if (!tiles.length) {
    await runWeatherUpdate();

    snapshot =
      await db
        .collection(
          WEATHER_COLLECTION,
        )
        .get();

    tiles =
      snapshot.docs
        .filter(
          (doc) =>
            doc.id !==
            WEATHER_META_DOCUMENT,
        )
        .map(
          (doc) =>
            serializeFirestore(
              doc.data(),
            ) as WeatherTile,
        );
  }

  const meta =
    await db
      .collection(
        WEATHER_META_COLLECTION,
      )
      .doc(
        WEATHER_META_DOCUMENT,
      )
      .get();

  const updateTimestamp =
    Number(
      meta
        .data()
        ?.updatedAt
        ?.toMillis?.() ??
        Date.now(),
    );

  const timeline =
    tiles.find(
      (tile) =>
        tile.timeline.length,
    )?.timeline ?? [];

  return {
    tiles,
    timeline,
    timestamp: Date.now(),
    updateTimestamp,
    nextUpdate:
      updateTimestamp +
      3600000,
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
