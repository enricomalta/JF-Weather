import {
  FieldValue,
  WEATHER_COLLECTION,
  WEATHER_META_COLLECTION,
  WEATHER_META_DOCUMENT,
  sendDiscordAlert,
  serializeFirestore,
  weatherDb,
} from "./firebase-admin";
import { loadNeighborhoods } from "./neighborhoods";
import type {
  GridResponse,
  TimelinePoint,
  WeatherData,
  WeatherTile,
} from "./types";

const TOMORROW_BASE_URL =
  "https://api.tomorrow.io/v4/timelines";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Limite operacional por key.
 *
 * O Tomorrow.io está retornando:
 * X-RateLimit-Limit-second: 2
 *
 * Portanto usamos no máximo 2 req/s por key.
 */
const REQUEST_INTERVAL_MS = 1_200;

/**
 * Limite operacional nosso por key.
 *
 * O Tomorrow.io pode informar um limite maior,
 * mas mantemos 20 tentativas por hora como proteção.
 */
const MAX_REQUESTS_PER_HOUR_PER_KEY = 20;

/**
 * Número máximo de tentativas de um bairro.
 */
const MAX_ATTEMPTS_PER_NEIGHBORHOOD = 1;

/**
 * Cooldown inicial para 429 sem Retry-After.
 */
const RATE_LIMIT_COOLDOWN_MS = 2_000;

/**
 * Backoff máximo interno.
 */
const MAX_RATE_LIMIT_COOLDOWN_MS = 5_000;

/**
 * Retry-After máximo.
 */
const MAX_EXPLICIT_RETRY_AFTER_MS = 5_000;

/**
 * Janela estimada da cota horária.
 *
 * Usamos uma hora a partir da última confirmação
 * de que a key estava sem quota.
 */
const HOURLY_RESET_ESTIMATE_MS = 60 * 60 * 1000;

/**
 * Coleção onde persistimos somente o estado das keys.
 *
 * IMPORTANTE:
 * As API keys continuam exclusivamente nas
 * variáveis de ambiente da Vercel.
 */
const TOMORROW_KEYS_COLLECTION = "tomorrowKeys";

const RETRYABLE_STATUS_CODES = new Set([
  429,
  500,
  502,
  503,
  504,
]);

const TIMELINE_FIELDS = [
  "temperature",
  "temperatureApparent",
  "humidity",
  "dewPoint",
  "precipitationIntensity",
  "precipitationProbability",
  "precipitationType",
  "windSpeed",
  "windDirection",
  "windGust",
  "pressureSurfaceLevel",
  "visibility",
  "cloudCover",
  "weatherCode",
] as const;

const TIMESTEPS = ["1h"] as const;

interface NeighborhoodPoint {
  id: string | number;
  name?: string;
  lat: number;
  lon: number;
}

interface TomorrowTimelineResponse {
  data?: {
    timelines?: Array<{
      timestep?: string;
      intervals?: Array<{
        startTime: string;
        values?: Record<string, unknown>;
      }>;
    }>;
  };
}

interface TomorrowError extends Error {
  status?: number;
  retryAfterMs?: number;
  headers?: Headers;
}

interface FailedWeatherTile extends WeatherTile {
  errorStatus?: number;
}

interface StoredWeatherTile extends WeatherTile {
  naoVerificado?: boolean;
  lastError?: string;
  lastErrorStatus?: number | null;
  lastErrorAt?: unknown;
}

interface PersistedApiKeyState {
  keyIndex: number;

  requestsThisHour?: number;
  hourStartedAt?: number;

  lastRequestAt?: number;

  cooldownUntil?: number;

  consecutiveRateLimitErrors?: number;

  hourExhausted?: boolean;

  rateLimitSecond?: number;
  rateLimitRemainingSecond?: number;

  rateLimitHour?: number;
  rateLimitRemainingHour?: number;

  /**
   * Momento estimado em que a janela horária
   * estará novamente disponível.
   */
  estimatedResetAt?: number;

  /**
   * Último status HTTP recebido.
   */
  lastStatus?: number;

  /**
   * Momento da última resposta recebida.
   */
  lastCheckedAt?: number;
}

interface ApiKeyState {
  keyIndex: number;
  apiKey: string;

  requestsThisHour: number;
  hourStartedAt: number;

  lastRequestAt: number;
  cooldownUntil: number;

  consecutiveRateLimitErrors: number;

  hourExhausted: boolean;

  rateLimitSecond?: number;
  rateLimitRemainingSecond?: number;

  rateLimitHour?: number;
  rateLimitRemainingHour?: number;

  estimatedResetAt?: number;

  lastStatus?: number;

  lastCheckedAt?: number;
}

interface WeatherJob {
  point: NeighborhoodPoint;
  attempts: number;
}

function sleep(ms: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

function getStatus(
  error: unknown,
): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status ===
      "number"
  ) {
    return (
      error as { status: number }
    ).status;
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getTomorrowKeys(): string[] {
  const keys: string[] = [];

  for (let i = 1; i <= 20; i += 1) {
    const key =
      process.env[`TOMORROW_API_KEY_${i}`];

    if (key?.trim()) {
      keys.push(key.trim());
    }
  }

  return keys;
}

function createTomorrowError(
  message: string,
  status?: number,
): TomorrowError {
  const error =
    new Error(message) as TomorrowError;

  error.status = status;

  return error;
}

function parseRetryAfter(
  headers: Headers,
): number | undefined {
  const value = headers.get("retry-after");

  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(
      0,
      Math.min(
        seconds * 1000,
        MAX_EXPLICIT_RETRY_AFTER_MS,
      ),
    );
  }

  const date = Date.parse(value);

  if (!Number.isNaN(date)) {
    return Math.max(
      0,
      Math.min(
        date - Date.now(),
        MAX_EXPLICIT_RETRY_AFTER_MS,
      ),
    );
  }

  return undefined;
}

/**
 * Atualiza o estado da key com os headers
 * retornados pelo Tomorrow.io.
 */
function updateRateLimitHeaders(
  state: ApiKeyState,
  headers: Headers,
) {
  const secondLimit =
    headers.get("x-ratelimit-limit-second");

  const secondRemaining =
    headers.get(
      "x-ratelimit-remaining-second",
    );

  const hourLimit =
    headers.get("x-ratelimit-limit-hour");

  const hourRemaining =
    headers.get(
      "x-ratelimit-remaining-hour",
    );

  if (secondLimit !== null) {
    const value = Number(secondLimit);

    if (Number.isFinite(value)) {
      state.rateLimitSecond = value;
    }
  }

  if (secondRemaining !== null) {
    const value = Number(secondRemaining);

    if (Number.isFinite(value)) {
      state.rateLimitRemainingSecond = value;
    }
  }

  if (hourLimit !== null) {
    const value = Number(hourLimit);

    if (Number.isFinite(value)) {
      state.rateLimitHour = value;
    }
  }

  if (hourRemaining !== null) {
    const value = Number(hourRemaining);

    if (Number.isFinite(value)) {
      state.rateLimitRemainingHour = value;

      /**
       * Se o próprio Tomorrow informou 0,
       * consideramos a key esgotada.
       */
      if (value <= 0) {
        state.hourExhausted = true;

        state.estimatedResetAt =
          Date.now() +
          HOURLY_RESET_ESTIMATE_MS;

        state.cooldownUntil = 0;
      } else {
        /**
         * Se voltou a existir quota, a key deixa
         * de ser considerada esgotada.
         */
        state.hourExhausted = false;
        state.estimatedResetAt = undefined;
      }
    }
  }

  // console.log(
  //   `[Tomorrow.io] Key ${state.keyIndex} headers:`,
  //   {
  //     secondLimit:
  //       secondLimit ??
  //       state.rateLimitSecond,

  //     secondRemaining:
  //       secondRemaining ??
  //       state.rateLimitRemainingSecond,

  //     hourLimit:
  //       hourLimit ??
  //       state.rateLimitHour,

  //     hourRemaining:
  //       hourRemaining ??
  //       state.rateLimitRemainingHour,
  //   },
  // );
}

/**
 * Persiste o estado operacional da key.
 *
 * A API key NÃO é salva.
 */
async function persistApiKeyState(
  state: ApiKeyState,
) {
  const db = weatherDb();

  const docRef = db
    .collection(WEATHER_META_COLLECTION)
    .doc(WEATHER_META_DOCUMENT)
    .collection(TOMORROW_KEYS_COLLECTION)
    .doc(`key_${state.keyIndex}`);

  await docRef.set(
    {
      keyIndex: state.keyIndex,

      requestsThisHour:
        state.requestsThisHour,

      hourStartedAt:
        state.hourStartedAt,

      lastRequestAt:
        state.lastRequestAt,

      cooldownUntil:
        state.cooldownUntil,

      consecutiveRateLimitErrors:
        state.consecutiveRateLimitErrors,

      hourExhausted:
        state.hourExhausted,

      rateLimitSecond:
        state.rateLimitSecond ?? null,

      rateLimitRemainingSecond:
        state.rateLimitRemainingSecond ??
        null,

      rateLimitHour:
        state.rateLimitHour ?? null,

      rateLimitRemainingHour:
        state.rateLimitRemainingHour ??
        null,

      estimatedResetAt:
        state.estimatedResetAt ?? null,

      lastStatus:
        state.lastStatus ?? null,

      lastCheckedAt:
        state.lastCheckedAt ??
        Date.now(),

      updatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    },
  );
}

/**
 * Carrega o estado anteriormente salvo.
 */
async function loadPersistedApiKeyStates(
  apiKeys: string[],
): Promise<ApiKeyState[]> {
  const db = weatherDb();

  const collectionRef = db
    .collection(WEATHER_META_COLLECTION)
    .doc(WEATHER_META_DOCUMENT)
    .collection(TOMORROW_KEYS_COLLECTION);

  const snapshot =
    await collectionRef.get();

  const persistedByIndex =
    new Map<number, PersistedApiKeyState>();

  for (const doc of snapshot.docs) {
    const data =
      doc.data() as PersistedApiKeyState;

    if (
      typeof data.keyIndex === "number"
    ) {
      persistedByIndex.set(
        data.keyIndex,
        data,
      );
    }
  }

  const now = Date.now();

  return apiKeys.map(
    (apiKey, index) => {
      const keyIndex = index + 1;

      const persisted =
        persistedByIndex.get(keyIndex);

      if (!persisted) {
        return createInitialKeyState(
          apiKey,
          keyIndex,
        );
      }

      const state: ApiKeyState = {
        keyIndex,
        apiKey,

        requestsThisHour:
          persisted.requestsThisHour ?? 0,

        hourStartedAt:
          persisted.hourStartedAt ?? now,

        lastRequestAt:
          persisted.lastRequestAt ?? 0,

        cooldownUntil:
          persisted.cooldownUntil ?? 0,

        consecutiveRateLimitErrors:
          persisted.consecutiveRateLimitErrors ??
          0,

        hourExhausted:
          persisted.hourExhausted ?? false,

        rateLimitSecond:
          persisted.rateLimitSecond,

        rateLimitRemainingSecond:
          persisted.rateLimitRemainingSecond,

        rateLimitHour:
          persisted.rateLimitHour,

        rateLimitRemainingHour:
          persisted.rateLimitRemainingHour,

        estimatedResetAt:
          persisted.estimatedResetAt,

        lastStatus:
          persisted.lastStatus,

        lastCheckedAt:
          persisted.lastCheckedAt,
      };

      resetHourlyStateIfNeeded(state);

      return state;
    },
  );
}

function resetHourlyStateIfNeeded(
  state: ApiKeyState,
) {
  const now = Date.now();

  /**
   * Se temos uma estimativa de reset e ela já passou,
   * liberamos a key para uma nova confirmação.
   */
  if (
    state.estimatedResetAt !== undefined &&
    now >= state.estimatedResetAt
  ) {
    state.requestsThisHour = 0;
    state.hourStartedAt = now;

    state.hourExhausted = false;

    state.rateLimitRemainingHour =
      undefined;

    state.estimatedResetAt =
      undefined;

    state.consecutiveRateLimitErrors =
      0;

    state.cooldownUntil = 0;

    // console.log(
    //   `[Tomorrow.io] Key ${state.keyIndex} passou do reset estimado. Liberada para nova confirmação.`,
    // );

    return;
  }

  /**
   * Fallback para o relógio local.
   */
  if (
    now - state.hourStartedAt >=
    HOURLY_RESET_ESTIMATE_MS
  ) {
    state.requestsThisHour = 0;
    state.hourStartedAt = now;

    state.hourExhausted = false;

    state.rateLimitRemainingHour =
      undefined;

    state.estimatedResetAt =
      undefined;

    state.consecutiveRateLimitErrors =
      0;

    state.cooldownUntil = 0;

    // console.log(
    //   `[Tomorrow.io] Key ${state.keyIndex} iniciou nova janela local de hora.`,
    // );
  }
}

function calculateRateLimitCooldown(
  state: ApiKeyState,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(
      Math.max(retryAfterMs, 500),
      MAX_EXPLICIT_RETRY_AFTER_MS,
    );
  }

  const exponent = Math.max(
    0,
    state.consecutiveRateLimitErrors - 1,
  );

  return Math.min(
    RATE_LIMIT_COOLDOWN_MS *
      2 ** exponent,
    MAX_RATE_LIMIT_COOLDOWN_MS,
  );
}

function createInitialKeyState(
  apiKey: string,
  keyIndex: number,
): ApiKeyState {
  return {
    keyIndex,
    apiKey,

    requestsThisHour: 0,

    hourStartedAt: Date.now(),

    lastRequestAt: 0,

    cooldownUntil: 0,

    consecutiveRateLimitErrors: 0,

    hourExhausted: false,
  };
}

/**
 * Retorna quanto falta para a key poder fazer
 * uma nova requisição.
 *
 * Infinity = key indisponível.
 */
function getWaitUntilAvailable(
  state: ApiKeyState,
): number {
  resetHourlyStateIfNeeded(state);

  const now = Date.now();

  /**
   * Se sabemos que a key está esgotada
   * e ainda não chegou ao reset estimado,
   * não fazemos chamada.
   */
  if (
    state.hourExhausted &&
    state.estimatedResetAt !== undefined &&
    now < state.estimatedResetAt
  ) {
    return Infinity;
  }

  /**
   * Se o servidor informou explicitamente
   * que não existe quota horária.
   */
  if (
    state.rateLimitRemainingHour !==
      undefined &&
    state.rateLimitRemainingHour <= 0
  ) {
    return Infinity;
  }

  /**
   * Nosso limite operacional.
   */
  if (
    state.requestsThisHour >=
    MAX_REQUESTS_PER_HOUR_PER_KEY
  ) {
    return Infinity;
  }

  const requestIntervalRemaining =
    state.lastRequestAt === 0
      ? 0
      : Math.max(
          0,
          REQUEST_INTERVAL_MS -
            (now - state.lastRequestAt),
        );

  const cooldownRemaining =
    Math.max(
      0,
      state.cooldownUntil - now,
    );

  return Math.max(
    requestIntervalRemaining,
    cooldownRemaining,
  );
}

function hasAvailableKey(
  states: ApiKeyState[],
) {
  return states.some(
    (state) =>
      Number.isFinite(
        getWaitUntilAvailable(state),
      ),
  );
}

async function requestTimeline(
  point: NeighborhoodPoint,
  apiKey: string,
): Promise<{
  data: TomorrowTimelineResponse;
  headers: Headers;
}> {
  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      TOMORROW_BASE_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "apikey": apiKey,
        },
        body: JSON.stringify({
          location: `${point.lat},${point.lon}`,
          fields: TIMELINE_FIELDS,
          timesteps: TIMESTEPS,
          startTime: "now",
          endTime: "nowPlus12h",
          units: "metric",
        }),
        signal: controller.signal,
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const errorBody =
        await response
          .text()
          .catch(() => "");

      const error =
        createTomorrowError(
          `Tomorrow.io retornou HTTP ${response.status}${
            errorBody
              ? `: ${errorBody.slice(0, 300)}`
              : ""
          }`,
          response.status,
        );

      error.headers =
        response.headers;

      error.retryAfterMs =
        parseRetryAfter(
          response.headers,
        );

      throw error;
    }

    const data =
      (await response.json()) as TomorrowTimelineResponse;

    return {
      data,
      headers: response.headers,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw createTomorrowError(
        `Timeout de ${REQUEST_TIMEOUT_MS}ms no Tomorrow.io.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeNumber(
  value: unknown,
  fallback = 0,
): number {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function getTimelineIntervals(
  response: TomorrowTimelineResponse,
) {
  const timeline =
    response.data?.timelines?.[0];

  return timeline?.intervals ?? [];
}

function buildWeatherData(
  values: Record<string, unknown>,
  timestamp: number,
): WeatherData {
  return {
    temperature:
      normalizeNumber(
        values.temperature,
      ),

    humidity:
      normalizeNumber(
        values.humidity,
      ),

    precipitation:
      normalizeNumber(
        values.precipitationIntensity,
      ),

    precipitationProbability:
      normalizeNumber(
        values.precipitationProbability,
      ),

    windSpeed:
      normalizeNumber(
        values.windSpeed,
      ),

    windDirection:
      normalizeNumber(
        values.windDirection,
      ),

    cloudCover:
      normalizeNumber(
        values.cloudCover,
      ),

    timestamp,
  };
}

function buildTimeline(
  response: TomorrowTimelineResponse,
): TimelinePoint[] {
  const intervals =
    getTimelineIntervals(response);

  return intervals.map(
    (interval) => {
      const timestamp =
        Date.parse(
          interval.startTime,
        );

      const values =
        interval.values ?? {};

      return {
        time:
          Number.isFinite(timestamp)
            ? timestamp
            : Date.now(),

        precipitation:
          normalizeNumber(
            values.precipitationIntensity,
          ),

        probability:
          normalizeNumber(
            values.precipitationProbability,
          ),
      };
    },
  );
}

function normalizeTimelineResponse(
  point: NeighborhoodPoint,
  response: TomorrowTimelineResponse,
): WeatherTile {
  const intervals =
    getTimelineIntervals(response);

  if (intervals.length === 0) {
    throw new Error(
      "Tomorrow.io não retornou intervalos na Timeline.",
    );
  }

  const first = intervals[0];

  const timestamp =
    Date.parse(
      first.startTime,
    );

  const data =
    buildWeatherData(
      first.values ?? {},
      Number.isFinite(timestamp)
        ? timestamp
        : Date.now(),
    );

  const timeline =
    buildTimeline(response);

  return {
    id: String(point.id),
    name: point.name,
    lat: point.lat,
    lon: point.lon,
    data,
    timeline,
  };
}

function createFailedTile(
  point: NeighborhoodPoint,
  message: string,
  status?: number,
): FailedWeatherTile {
  return {
    id: String(point.id),
    name: point.name,
    lat: point.lat,
    lon: point.lon,
    data: null,
    timeline: [],
    error: message,
    errorStatus: status,
  };
}

class ApiKeyWorker {
  constructor(
    private readonly state: ApiKeyState,
  ) {}

  get keyIndex() {
    return this.state.keyIndex;
  }

  get waitUntilAvailable() {
    return getWaitUntilAvailable(
      this.state,
    );
  }

  async execute(
    point: NeighborhoodPoint,
  ): Promise<WeatherTile> {
    resetHourlyStateIfNeeded(
      this.state,
    );

    const waitTime =
      this.waitUntilAvailable;

    if (!Number.isFinite(waitTime)) {
      throw new Error(
        `Key ${this.state.keyIndex} indisponível.`,
      );
    }

    if (waitTime > 0) {
      await sleep(waitTime);
    }

    /**
     * Conta a tentativa antes da chamada.
     */
    this.state.requestsThisHour += 1;

    this.state.lastRequestAt =
      Date.now();

    this.state.lastCheckedAt =
      Date.now();

    try {
      const result =
        await requestTimeline(
          point,
          this.state.apiKey,
        );

      /**
       * Headers reais do servidor.
       */
      updateRateLimitHeaders(
        this.state,
        result.headers,
      );

      this.state.lastStatus = 200;

      this.state.consecutiveRateLimitErrors =
        0;

      this.state.cooldownUntil = 0;

      /**
       * Persiste o estado imediatamente
       * após a resposta.
       */
      await persistApiKeyState(
        this.state,
      );

      console.log(
        `[Tomorrow.io] Key ${this.state.keyIndex} → bairro ${point.id} sucesso.`,
      );

      return normalizeTimelineResponse(
        point,
        result.data,
      );
    } catch (error) {
      const tomorrowError =
        error as TomorrowError;

      const status =
        tomorrowError.status;

      this.state.lastStatus =
        status;

      this.state.lastCheckedAt =
        Date.now();

      /**
       * Captura headers mesmo em 429.
       */
      if (tomorrowError.headers) {
        updateRateLimitHeaders(
          this.state,
          tomorrowError.headers,
        );
      }

      if (status === 429) {
        this.state.consecutiveRateLimitErrors +=
          1;

        /**
         * Se a API informou que acabou
         * a quota horária, estimamos o reset.
         */
        if (
          this.state
            .rateLimitRemainingHour !==
            undefined &&
          this.state
            .rateLimitRemainingHour <= 0
        ) {
          this.state.hourExhausted =
            true;

          this.state.estimatedResetAt =
            Date.now() +
            HOURLY_RESET_ESTIMATE_MS;

          this.state.cooldownUntil = 0;

          // console.warn(
          //   `[Tomorrow.io] Key ${this.state.keyIndex} esgotou a cota horária. Reset estimado para ${formatBrazilDate(
          //     this.state.estimatedResetAt,
          //   )}.`,
          // );
        } else {
          const cooldown =
            calculateRateLimitCooldown(
              this.state,
              tomorrowError.retryAfterMs,
            );

          this.state.cooldownUntil =
            Date.now() + cooldown;

          // console.warn(
          //   `[Tomorrow.io] Key ${this.state.keyIndex} recebeu 429. Cooldown: ${cooldown}ms.`,
          // );
        }

        await persistApiKeyState(
          this.state,
        );

        throw error;
      }

      if (
        status !== undefined &&
        RETRYABLE_STATUS_CODES.has(
          status,
        )
      ) {
        this.state.cooldownUntil =
          Date.now() + 1_000;

        await persistApiKeyState(
          this.state,
        );

        // console.warn(
        //   `[Tomorrow.io] Key ${this.state.keyIndex} recebeu HTTP ${status}.`,
        // );

        throw error;
      }

      await persistApiKeyState(
        this.state,
      );

      throw error;
    }
  }
}

// OLD ONE a ONE
// async function processQueue(
//   jobs: WeatherJob[],
//   workers: ApiKeyWorker[],
// ): Promise<Map<string, WeatherTile>> {
//   const results = new Map<string, WeatherTile>();

//   const queue = [...jobs];

//   let workerIndex = 0;

//   /**
//    * Intervalo GLOBAL entre o início de cada requisição.
//    *
//    * Não existem mais 8 requisições simultâneas.
//    * Apenas uma chamada ao Tomorrow.io acontece por vez.
//    */
//   let nextRequestAt = 0;

//   while (queue.length > 0) {
//     /**
//      * Se todas as keys estiverem indisponíveis,
//      * não fazemos chamadas inúteis.
//      */
//     const availableWorkers = workers.filter(
//       (worker) =>
//         Number.isFinite(
//           worker.waitUntilAvailable,
//         ),
//     );

//     if (availableWorkers.length === 0) {
//       console.warn(
//         "[Tomorrow.io] Todas as API keys estão indisponíveis. Encerrando fila.",
//       );

//       break;
//     }

//     /**
//      * Procura a próxima key disponível
//      * seguindo ordem circular:
//      *
//      * Key 1 → Key 2 → ... → Key 8 → Key 1
//      */
//     let selectedWorker: ApiKeyWorker | undefined;

//     for (
//       let attempts = 0;
//       attempts < workers.length;
//       attempts += 1
//     ) {
//       const candidate =
//         workers[workerIndex];

//       workerIndex =
//         (workerIndex + 1) %
//         workers.length;

//       if (
//         Number.isFinite(
//           candidate.waitUntilAvailable,
//         )
//       ) {
//         selectedWorker = candidate;
//         break;
//       }
//     }

//     if (!selectedWorker) {
//       break;
//     }

//     /**
//      * Respeita o intervalo GLOBAL de 3 segundos
//      * entre o início das chamadas.
//      */
//     const now = Date.now();

//     const globalWait =
//       Math.max(
//         0,
//         nextRequestAt - now,
//       );

//     if (globalWait > 0) {
//       await sleep(globalWait);
//     }

//     /**
//      * Depois da espera global, a key pode ter
//      * entrado em cooldown. Nesse caso deixamos
//      * a próxima iteração escolher outra.
//      */
//     const keyWait =
//       selectedWorker.waitUntilAvailable;

//     if (!Number.isFinite(keyWait)) {
//       continue;
//     }

//     if (keyWait > 0) {
//       await sleep(keyWait);
//     }

//     /**
//      * Pega o próximo bairro.
//      */
//     const job = queue.shift();

//     if (!job) {
//       break;
//     }

//     const jobId =
//       String(job.point.id);

//     /**
//      * Evita processar novamente um bairro
//      * que já teve sucesso.
//      */
//     if (results.has(jobId)) {
//       continue;
//     }

//     if (
//       job.attempts >=
//       MAX_ATTEMPTS_PER_NEIGHBORHOOD
//     ) {
//       results.set(
//         jobId,
//         createFailedTile(
//           job.point,
//           `Número máximo de tentativas atingido (${MAX_ATTEMPTS_PER_NEIGHBORHOOD}).`,
//         ),
//       );

//       continue;
//     }

//     job.attempts += 1;

//     console.log(
//       `[Tomorrow.io] Key ${selectedWorker.keyIndex} → bairro ${job.point.id} (${job.attempts}/${MAX_ATTEMPTS_PER_NEIGHBORHOOD})`,
//     );

//     /**
//      * A próxima chamada só poderá começar
//      * depois de 3 segundos.
//      *
//      * Importante:
//      * o timestamp é atualizado ANTES da chamada,
//      * então o intervalo é contado entre inícios
//      * de requisições.
//      */
//     nextRequestAt =
//       Date.now() +
//       REQUEST_INTERVAL_MS;

//     try {
//       const tile =
//         await selectedWorker.execute(
//           job.point,
//         );

//       if (!results.has(jobId)) {
//         results.set(
//           jobId,
//           tile,
//         );
//       }

//       console.log(
//         `[Tomorrow.io] Bairro ${job.point.id} concluído pela Key ${selectedWorker.keyIndex}.`,
//       );
//     } catch (error) {
//       const status =
//         getStatus(error);

//       const message =
//         getErrorMessage(error);

//       /**
//        * 429:
//        *
//        * O bairro volta para o final da fila.
//        * A próxima tentativa será feita por outra
//        * key, seguindo o rodízio.
//        */
//       if (
//         status === 429 &&
//         job.attempts <
//           MAX_ATTEMPTS_PER_NEIGHBORHOOD
//       ) {
//         queue.push(job);

//         console.warn(
//           `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após 429.`,
//         );

//         continue;
//       }

//       /**
//        * Outros erros temporários.
//        */
//       if (
//         status !== undefined &&
//         RETRYABLE_STATUS_CODES.has(
//           status,
//         ) &&
//         job.attempts <
//           MAX_ATTEMPTS_PER_NEIGHBORHOOD
//       ) {
//         queue.push(job);

//         console.warn(
//           `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após HTTP ${status}.`,
//         );

//         continue;
//       }

//       /**
//        * Timeout / erro de rede.
//        */
//       if (
//         status === undefined &&
//         job.attempts <
//           MAX_ATTEMPTS_PER_NEIGHBORHOOD
//       ) {
//         queue.push(job);

//         console.warn(
//           `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após erro: ${message}`,
//         );

//         continue;
//       }

//       /**
//        * Falha definitiva.
//        */
//       if (!results.has(jobId)) {
//         results.set(
//           jobId,
//           createFailedTile(
//             job.point,
//             message,
//             status,
//           ),
//         );
//       }

//       console.error(
//         `[Tomorrow.io] Bairro ${job.point.id} falhou definitivamente: ${message}`,
//       );
//     }
//   }

//   /**
//    * Se as keys acabaram antes da fila,
//    * marcamos os restantes como falha.
//    */
//   for (const job of jobs) {
//     const id =
//       String(job.point.id);

//     if (results.has(id)) {
//       continue;
//     }

//     results.set(
//       id,
//       createFailedTile(
//         job.point,
//         "Nenhuma API key disponível para processar este bairro nesta execução.",
//       ),
//     );
//   }

//   return results;
// }

async function processQueue(
  jobs: WeatherJob[],
  workers: ApiKeyWorker[],
): Promise<Map<string, WeatherTile>> {
  const results = new Map<string, WeatherTile>();
  const queue = [...jobs];

  if (queue.length === 0 || workers.length === 0) {
    return results;
  }


  /**
   * Cada ApiKeyWorker possui seu próprio estado e seu
   * próprio lastRequestAt.
   *
   * Portanto as 8 keys podem trabalhar simultaneamente.
   */
  const processWorker = async (
    worker: ApiKeyWorker,
  ): Promise<void> => {
    while (true) {
      /**
       * shift() acontece de forma síncrona antes de qualquer await,
       * portanto dois workers não pegam o mesmo job.
       */
      const job = queue.shift();

      if (!job) {
        return;
      }

      const jobId = String(job.point.id);

      /**
       * Se por algum motivo esse bairro já foi concluído,
       * não processamos novamente.
       */
      if (results.has(jobId)) {
        continue;
      }

      /**
       * Se já atingiu o limite de tentativas, falha definitivamente.
       */
      if (
        job.attempts >=
        MAX_ATTEMPTS_PER_NEIGHBORHOOD
      ) {
        results.set(
          jobId,
          createFailedTile(
            job.point,
            `Número máximo de tentativas atingido (${MAX_ATTEMPTS_PER_NEIGHBORHOOD}).`,
          ),
        );

        continue;
      }

      /**
       * Verifica se esta key ainda está operacional.
       *
       * Infinity significa que ela está esgotada/indisponível.
       */
      if (
        !Number.isFinite(
          worker.waitUntilAvailable,
        )
      ) {
        // console.warn(
        //   `[Tomorrow.io] Key ${worker.keyIndex} indisponível. ` +
        //     `Ela não continuará processando novos bairros nesta execução.`,
        // );

        /**
         * O job volta para a fila para que outra key possa pegá-lo.
         */
        queue.push(job);

        return;
      }

      job.attempts += 1;

      console.log(
        `[Tomorrow.io] Key ${worker.keyIndex} → bairro ${job.point.id} ` +
          `(${job.attempts}/${MAX_ATTEMPTS_PER_NEIGHBORHOOD})`,
      );

      try {
        const tile = await worker.execute(
          job.point,
        );

        /**
         * Só o primeiro sucesso entra no resultado.
         */
        if (!results.has(jobId)) {
          results.set(jobId, tile);
        }

        // console.log(
        //   `[Tomorrow.io] Bairro ${job.point.id} concluído pela Key ${worker.keyIndex}.`,
        // );
      } catch (error) {
        const status = getStatus(error);
        const message = getErrorMessage(error);

        /**
         * 429:
         *
         * O worker que recebeu o 429 entra em cooldown
         * através do ApiKeyWorker.execute().
         *
         * O bairro volta para a fila e pode ser processado
         * por outra key.
         */
        if (
          status === 429 &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          queue.push(job);

          // console.warn(
          //   `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após 429.`,
          // );

          continue;
        }

        /**
         * Outros erros temporários:
         * 500, 502, 503, 504.
         */
        if (
          status !== undefined &&
          RETRYABLE_STATUS_CODES.has(status) &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          queue.push(job);

          // console.warn(
          //   `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após HTTP ${status}.`,
          // );

          continue;
        }

        /**
         * Timeout / erro de rede.
         */
        if (
          status === undefined &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          queue.push(job);

          // console.warn(
          //   `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após erro: ${message}`,
          // );

          continue;
        }

        /**
         * Falha definitiva.
         */
        if (!results.has(jobId)) {
          results.set(
            jobId,
            createFailedTile(
              job.point,
              message,
              status,
            ),
          );
        }

        console.error(
          `[Tomorrow.io] Bairro ${job.point.id} falhou definitivamente: ${message}`,
        );
      }
    }
  };

  /**
   * Os 8 workers começam simultaneamente.
   *
   * Cada um controla seu próprio intervalo através
   * do estado da sua ApiKeyWorker.
   */
  await Promise.all(
    workers.map((worker) =>
      processWorker(worker),
    ),
  );

  /**
   * Caso alguma key tenha ficado indisponível antes do
   * restante da fila ser processado, marcamos os bairros
   * restantes como falha.
   */
  for (const job of queue) {
    const jobId = String(job.point.id);

    if (results.has(jobId)) {
      continue;
    }

    results.set(
      jobId,
      createFailedTile(
        job.point,
        "Nenhuma API key disponível para processar este bairro nesta execução.",
      ),
    );
  }

  console.log(
    `[Radar JF] Processamento paralelo finalizado. ` +
      `${results.size}/${jobs.length} bairros processados.`,
  );

  return results;
}

async function saveResults(
  tiles: Map<string, WeatherTile>,
): Promise<{
  updatedCount: number;
  failedCount: number;
}> {
  const db = weatherDb();

  const collectionRef =
    db.collection(
      WEATHER_COLLECTION,
    );

  const existingSnapshot =
    await collectionRef.get();

  const existingIds =
    new Set<string>();

  for (
    const doc of
    existingSnapshot.docs
  ) {
    existingIds.add(doc.id);
  }

  const batch =
    db.batch();

  let updatedCount = 0;
  let failedCount = 0;

  for (
    const tile of
    tiles.values()
  ) {
    const id =
      String(tile.id);

    const docRef =
      collectionRef.doc(id);

    const failed =
      tile.data === null;

    if (!failed) {
      batch.set(
        docRef,
        {
          id,

          name:
            tile.name ?? null,

          lat: tile.lat,

          lon: tile.lon,

          data: tile.data,

          timeline:
            tile.timeline,

          naoVerificado:
            false,

          lastError:
            FieldValue.delete(),

          lastErrorStatus:
            FieldValue.delete(),

          lastErrorAt:
            FieldValue.delete(),

          error:
            FieldValue.delete(),

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        },
      );

      updatedCount += 1;

      continue;
    }

    failedCount += 1;

    if (existingIds.has(id)) {
      const failedTile =
        tile as FailedWeatherTile;

      batch.set(
        docRef,
        {
          id,

          name:
            tile.name ?? null,

          lat: tile.lat,

          lon: tile.lon,

          naoVerificado:
            true,

          lastError:
            tile.error ??
            "Erro desconhecido.",

          lastErrorStatus:
            failedTile.errorStatus ??
            null,

          lastErrorAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        },
      );

      continue;
    }

    const failedTile =
      tile as FailedWeatherTile;

    batch.set(
      docRef,
      {
        id,

        name:
          tile.name ?? null,

        lat: tile.lat,

        lon: tile.lon,

        data: null,

        timeline: [],

        naoVerificado:
          true,

        lastError:
          tile.error ??
          "Erro desconhecido.",

        lastErrorStatus:
          failedTile.errorStatus ??
          null,

        lastErrorAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );
  }

  console.log(
    `[Radar JF] Salvando ${tiles.size} resultados no Firestore...`,
  );

  await batch.commit();

  console.log(
    `[Radar JF] Firestore commit concluído. ${updatedCount} atualizados, ${failedCount} falhos.`,
  );

  return {
    updatedCount,
    failedCount,
  };
}

async function updateMetadata(
  neighborhoodCount: number,
  updatedCount: number,
  failedCount: number,
) {
  const db = weatherDb();

  const metaRef =
    db
      .collection(
        WEATHER_META_COLLECTION,
      )
      .doc(
        WEATHER_META_DOCUMENT,
      );

  const payload:
    Record<string, unknown> = {
    source:
      "tomorrow.io",

    neighborhoodCount,

    updatedCount,

    failedCount,

    lastRunAt:
      FieldValue.serverTimestamp(),
  };

  if (updatedCount > 0) {
    payload.updatedAt =
      FieldValue.serverTimestamp();
  }

  await metaRef.set(
    payload,
    {
      merge: true,
    },
  );
}

async function sendRainAlerts(
  results: Map<string, WeatherTile>,
) {
  const alerts = Array.from(results.values())
    .filter(
      (tile) =>
        tile.timeline[0]?.precipitation > 0 ||
        (tile.data?.precipitation ?? 0) > 0,
    )
    .map((tile) => tile.name)
    .filter(
      (name): name is string =>
        Boolean(name),
    );

  if (!alerts.length) {
    return 0;
  }

  await sendDiscordAlert(
    `JF Radar: chuva agora ou na próxima hora em ${alerts.join(
      ", ",
    )}. Accesse nossa plataforma para mais detalhes: https://jf-radar.vercel.app/`,
  );

  return alerts.length;
}

export async function runWeatherUpdate() {
  console.log(
    "[Radar JF] Iniciando atualização meteorológica...",
  );

  const neighborhoods =
    await loadNeighborhoods();

  console.log(
    `[Radar JF] ${neighborhoods.length} bairros encontrados.`,
  );

  const apiKeys =
    getTomorrowKeys();

  console.log(
    `[Radar JF] ${apiKeys.length} keys disponíveis.`,
  );

  if (apiKeys.length === 0) {
    throw new Error(
      "Nenhuma TOMORROW_API_KEY configurada.",
    );
  }

  /**
   * NOVO:
   *
   * Carrega o estado persistido das keys
   * antes de começar qualquer chamada.
   */
  const states =
    await loadPersistedApiKeyStates(
      apiKeys,
    );

  // console.log(
  //   "[Radar JF] Estado persistido das keys carregado.",
  // );

  for (const state of states) {
    // console.log(
    //   `[Radar JF] Key ${state.keyIndex}:`,
    //   {
    //     requestsThisHour:
    //       state.requestsThisHour,

    //     hourRemaining:
    //       state.rateLimitRemainingHour,

    //     hourExhausted:
    //       state.hourExhausted,

    //     estimatedResetAt:
    //       state.estimatedResetAt
    //         ? new Date(
    //             state.estimatedResetAt,
    //           ).toISOString()
    //         : null,
    //   },
    // );
  }

  /**
   * Persiste qualquer reset local detectado.
   */
  await Promise.all(
    states.map(
      (state) =>
        persistApiKeyState(
          state,
        ),
    ),
  );

  const workers =
    states.map(
      (state) =>
        new ApiKeyWorker(state),
    );

  /**
   * Antes de criar a fila, verificamos
   * se existe pelo menos uma key disponível.
   */
  if (!hasAvailableKey(states)) {
    const nextResetTimes =
      states
        .map(
          (state) =>
            state.estimatedResetAt,
        )
        .filter(
          (
            value,
          ): value is number =>
            typeof value ===
            "number",
        )
        .sort(
          (a, b) => a - b,
        );

    const nextReset =
      nextResetTimes[0];

    const message =
      nextReset
        ? `Todas as API keys estão temporariamente indisponíveis. Próximo reset estimado: ${formatBrazilDate(
            nextReset,
          )}.`
        : "Todas as API keys estão temporariamente indisponíveis.";

    console.warn(`[Radar JF] ${message}`);

    await sendDiscordAlert(
      `⏳ Radar JF: Nenhuma API key disponível no momento. ${
        nextReset
          ? `Próximo reset estimado: ${formatBrazilDate(nextReset)} (horário de Brasília).`
          : ""
      }`,
    ).catch((error) => {
      console.error(
        "[Radar JF] Erro ao enviar alerta Discord:",
        error,
      );
    });

    return {
      ok: false,
      neighborhoodCount:
        neighborhoods.length,
      updatedCount: 0,
      failedCount:
        neighborhoods.length,
      tiles: neighborhoods.map(
        (point) =>
          createFailedTile(
            {
              id: point.id,
              name: point.name,
              lat: Number(
                point.lat,
              ),
              lon: Number(
                point.lon,
              ),
            },
            message,
          ),
      ),
    };
  }

  const jobs: WeatherJob[] =
    neighborhoods.map(
      (point) => ({
        point: {
          id: point.id,
          name: point.name,
          lat: Number(
            point.lat,
          ),
          lon: Number(
            point.lon,
          ),
        },

        attempts: 0,
      }),
    );

  // console.log(
  //   `[Radar JF] Iniciando fila global sequencial com ${workers.length} keys. Intervalo entre requisições: ${REQUEST_INTERVAL_MS}ms.`,
  // );

  const results =
    await processQueue(
      jobs,
      workers,
    );

  const {
    updatedCount,
    failedCount,
  } =
    await saveResults(
      results,
    );

  const alerts = await sendRainAlerts(results);

  await updateMetadata(
    neighborhoods.length,
    updatedCount,
    failedCount,
  );

  console.log(
    `[Radar JF] Finalizado. ${updatedCount} bairros atualizados, ${failedCount} falharam.`,
  );

  if (failedCount > 0) {
    await sendDiscordAlert(
      `⚠️ Radar JF: ${updatedCount}/${neighborhoods.length} bairros atualizados. ${failedCount} falharam.`,
    ).catch((error) => {
      console.error(
        "[Radar JF] Erro ao enviar alerta Discord:",
        error,
      );
    });
  }

  return {
    ok: true,

    neighborhoodCount:
      neighborhoods.length,

    updatedCount,

    failedCount,

    alerts,

    tiles:
      Array.from(
        results.values(),
      ),
  };
}

/**
 * Atualização manual continua desativada.
 *
 * Somente o cron executa runWeatherUpdate().
 */
export async function refreshWeather() {
  return {
    ok: false,

    status: 410,

    message:
      "Atualização manual desativada. A atualização meteorológica ocorre exclusivamente pelo cron.",
  };
}

export async function readWeather(): Promise<GridResponse> {
  const db =
    weatherDb();

  const snapshot =
    await db
      .collection(
        WEATHER_COLLECTION,
      )
      .get();

  const metaSnapshot =
    await db
      .collection(
        WEATHER_META_COLLECTION,
      )
      .doc(
        WEATHER_META_DOCUMENT,
      )
      .get();

  const tiles: WeatherTile[] =
    snapshot.docs.map(
      (doc) => {
        const data =
          doc.data() as StoredWeatherTile;

        return {
          id:
            data.id ??
            doc.id,

          name:
            data.name,

          lat:
            data.lat,

          lon:
            data.lon,

          data:
            data.data ??
            null,

          timeline:
            data.timeline ??
            [],

          error:
            data.naoVerificado
              ? data.lastError
              : undefined,
        };
      },
    );

  const hasUnverified =
    snapshot.docs.some(
      (doc) => {
        const data =
          doc.data() as StoredWeatherTile;

        return (
          // data.naoVerificado === true ||
          data.data === null
        );
      },
    );

  const meta =
    metaSnapshot.exists
      ? metaSnapshot.data()
      : null;

  const updatedAtValue =
    meta?.updatedAt;

  let updateTimestamp = 0;

  if (
    updatedAtValue &&
    typeof updatedAtValue ===
      "object" &&
    "toMillis" in
      updatedAtValue &&
    typeof (
      updatedAtValue as {
        toMillis?: unknown;
      }
    ).toMillis ===
      "function"
  ) {
    updateTimestamp = (
      updatedAtValue as {
        toMillis: () => number;
      }
    ).toMillis();
  }

  if (
    !updateTimestamp &&
    meta?.lastRunAt
  ) {
    const lastRunAt =
      meta.lastRunAt;

    if (
      typeof lastRunAt ===
        "object" &&
      "toMillis" in
        lastRunAt &&
      typeof (
        lastRunAt as {
          toMillis?: unknown;
        }
      ).toMillis ===
        "function"
    ) {
      updateTimestamp = (
        lastRunAt as {
          toMillis: () => number;
        }
      ).toMillis();
    }
  }

  const now =
    Date.now();

  const nextUpdate =
    updateTimestamp > 0
      ? updateTimestamp +
        60 * 60 * 1000
      : 0;

  let status:
    GridResponse["status"];

  if (tiles.length === 0) {
    status = "error";
  } else if (hasUnverified) {
    status = "partial";
  } else {
    status = "success";
  }

  return serializeFirestore({
    tiles,

    timeline: [],

    timestamp: now,

    updateTimestamp,

    nextUpdate,

    status,

    message:
      tiles.length === 0
        ? "Nenhum dado meteorológico disponível. Aguarde a execução do cron."
        : hasUnverified
          ? "Alguns bairros não foram verificados na última atualização."
          : undefined,
  });
}


function formatBrazilDate(timestamp: number | null) {
  if (!timestamp) return "não definido";

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}