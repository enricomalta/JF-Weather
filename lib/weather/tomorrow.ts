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

const TOMORROW_BASE_URL = "https://api.tomorrow.io/v4/timelines";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Limite operacional por key.
 *
 * O Tomorrow.io está retornando headers como:
 * X-RateLimit-Limit-second: 2
 *
 * Portanto usamos no máximo 2 req/s por key.
 */
const MAX_REQUESTS_PER_SECOND_PER_KEY = 2;
const REQUEST_INTERVAL_MS =
  1000 / MAX_REQUESTS_PER_SECOND_PER_KEY;

/**
 * Limite operacional local por execução/hora.
 *
 * Não é necessariamente o limite real da conta.
 * É apenas uma proteção nossa.
 */
const MAX_REQUESTS_PER_HOUR_PER_KEY = 20;

/**
 * Número máximo de tentativas de um bairro.
 *
 * Uma tentativa que recebe 429 volta para a fila
 * e pode ser executada por outra key.
 */
const MAX_ATTEMPTS_PER_NEIGHBORHOOD = 4;

/**
 * Cooldown inicial para 429 sem informação suficiente.
 */
const RATE_LIMIT_COOLDOWN_MS = 2_000;

/**
 * Não deixamos o nosso próprio backoff crescer para 60s.
 *
 * Se o servidor fornecer Retry-After, usamos no máximo este valor.
 */
const MAX_RATE_LIMIT_COOLDOWN_MS = 5_000;

/**
 * Retry-After explícito também é limitado para que uma execução
 * do cron não fique presa por dezenas de segundos.
 */
const MAX_EXPLICIT_RETRY_AFTER_MS = 5_000;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

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

interface ApiKeyState {
  keyIndex: number;
  apiKey: string;

  requestsThisHour: number;
  hourStartedAt: number;

  lastRequestAt: number;
  cooldownUntil: number;

  consecutiveRateLimitErrors: number;

  /**
   * Quando true, a key não participa mais desta execução.
   *
   * Isso acontece quando o Tomorrow.io informa:
   * X-RateLimit-Remaining-hour: 0
   */
  hourExhausted: boolean;

  rateLimitSecond?: number;
  rateLimitRemainingSecond?: number;
  rateLimitHour?: number;
  rateLimitRemainingHour?: number;
}

interface WeatherJob {
  point: NeighborhoodPoint;
  attempts: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
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
    const key = process.env[`TOMORROW_API_KEY_${i}`];

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
  const error = new Error(message) as TomorrowError;
  error.status = status;
  return error;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");

  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(
      0,
      Math.min(seconds * 1000, MAX_EXPLICIT_RETRY_AFTER_MS),
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

function updateRateLimitHeaders(
  state: ApiKeyState,
  headers: Headers,
) {
  const secondLimit = headers.get("x-ratelimit-limit-second");
  const secondRemaining = headers.get(
    "x-ratelimit-remaining-second",
  );
  const hourLimit = headers.get("x-ratelimit-limit-hour");
  const hourRemaining = headers.get(
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
       * IMPORTANTÍSSIMO:
       *
       * Se o próprio Tomorrow disser que a key chegou a 0
       * na janela de hora, não adianta continuar tentando.
       */
      if (value <= 0) {
        state.hourExhausted = true;
        state.cooldownUntil = 0;
      }
    }
  }

  console.log(
    `[Tomorrow.io] Key ${state.keyIndex} headers:`,
    {
      secondLimit: secondLimit ?? state.rateLimitSecond,
      secondRemaining:
        secondRemaining ?? state.rateLimitRemainingSecond,
      hourLimit: hourLimit ?? state.rateLimitHour,
      hourRemaining:
        hourRemaining ?? state.rateLimitRemainingHour,
    },
  );
}

function resetHourlyStateIfNeeded(state: ApiKeyState) {
  const now = Date.now();

  if (now - state.hourStartedAt < 60 * 60 * 1000) {
    return;
  }

  state.requestsThisHour = 0;
  state.hourStartedAt = now;
  state.hourExhausted = false;
  state.rateLimitRemainingHour = undefined;
  state.consecutiveRateLimitErrors = 0;

  console.log(
    `[Tomorrow.io] Key ${state.keyIndex} iniciou nova janela local de hora.`,
  );
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
    RATE_LIMIT_COOLDOWN_MS * 2 ** exponent,
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

function getWaitUntilAvailable(
  state: ApiKeyState,
): number {
  resetHourlyStateIfNeeded(state);

  if (state.hourExhausted) {
    return Infinity;
  }

  if (
    state.requestsThisHour >=
    MAX_REQUESTS_PER_HOUR_PER_KEY
  ) {
    return Infinity;
  }

  const now = Date.now();

  const requestIntervalRemaining =
    state.lastRequestAt === 0
      ? 0
      : Math.max(
          0,
          REQUEST_INTERVAL_MS -
            (now - state.lastRequestAt),
        );

  const cooldownRemaining = Math.max(
    0,
    state.cooldownUntil - now,
  );

  return Math.max(
    requestIntervalRemaining,
    cooldownRemaining,
  );
}

function hasAvailableKey(states: ApiKeyState[]) {
  return states.some(
    (state) =>
      Number.isFinite(getWaitUntilAvailable(state)),
  );
}

async function requestTimeline(
  point: NeighborhoodPoint,
  apiKey: string,
): Promise<{
  data: TomorrowTimelineResponse;
  headers: Headers;
}> {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(TOMORROW_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: `${point.lat},${point.lon}`,
        fields: TIMELINE_FIELDS,
        timesteps: TIMESTEPS,
        startTime: "now",
        endTime: "nowPlus12h",
        units: "metric",
        apikey: apiKey,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    /**
     * IMPORTANTE:
     *
     * Capturamos os headers ANTES de lançar o erro.
     *
     * O código anterior perdia esses headers nos 429,
     * por isso aparecia:
     *
     * secondLimit: undefined
     * hourRemaining: undefined
     */
    if (!response.ok) {
      const errorBody = await response.text().catch(
        () => "",
      );

      const error = createTomorrowError(
        `Tomorrow.io retornou HTTP ${response.status}${
          errorBody
            ? `: ${errorBody.slice(0, 300)}`
            : ""
        }`,
        response.status,
      );

      error.headers = response.headers;
      error.retryAfterMs =
        parseRetryAfter(response.headers);

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
      const timeoutError = createTomorrowError(
        `Timeout de ${REQUEST_TIMEOUT_MS}ms no Tomorrow.io.`,
      );

      throw timeoutError;
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
    temperature: normalizeNumber(
      values.temperature,
    ),
    humidity: normalizeNumber(values.humidity),
    precipitation: normalizeNumber(
      values.precipitationIntensity,
    ),
    precipitationProbability: normalizeNumber(
      values.precipitationProbability,
    ),
    windSpeed: normalizeNumber(values.windSpeed),
    windDirection: normalizeNumber(
      values.windDirection,
    ),
    cloudCover: normalizeNumber(
      values.cloudCover,
    ),
    timestamp,
  };
}

function buildTimeline(
  response: TomorrowTimelineResponse,
): TimelinePoint[] {
  const intervals = getTimelineIntervals(response);

  return intervals.map((interval) => {
    const timestamp = Date.parse(
      interval.startTime,
    );

    const values = interval.values ?? {};

    return {
      time: Number.isFinite(timestamp)
        ? timestamp
        : Date.now(),
      precipitation: normalizeNumber(
        values.precipitationIntensity,
      ),
      probability: normalizeNumber(
        values.precipitationProbability,
      ),
    };
  });
}

function normalizeTimelineResponse(
  point: NeighborhoodPoint,
  response: TomorrowTimelineResponse,
): WeatherTile {
  const intervals = getTimelineIntervals(response);

  if (intervals.length === 0) {
    throw new Error(
      "Tomorrow.io não retornou intervalos na Timeline.",
    );
  }

  const first = intervals[0];

  const timestamp = Date.parse(
    first.startTime,
  );

  const data = buildWeatherData(
    first.values ?? {},
    Number.isFinite(timestamp)
      ? timestamp
      : Date.now(),
  );

  const timeline = buildTimeline(response);

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
    return getWaitUntilAvailable(this.state);
  }

  async execute(
    point: NeighborhoodPoint,
  ): Promise<WeatherTile> {
    resetHourlyStateIfNeeded(this.state);

    const waitTime = this.waitUntilAvailable;

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
     *
     * Isso protege contra ficar fazendo infinitos 429.
     */
    this.state.requestsThisHour += 1;
    this.state.lastRequestAt = Date.now();

    try {
      const result = await requestTimeline(
        point,
        this.state.apiKey,
      );

      /**
       * Headers também são atualizados no sucesso.
       */
      updateRateLimitHeaders(
        this.state,
        result.headers,
      );

      this.state.consecutiveRateLimitErrors = 0;
      this.state.cooldownUntil = 0;

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

      /**
       * Recupera os headers do erro.
       *
       * Isso é especialmente importante nos 429.
       */
      if (tomorrowError.headers) {
        updateRateLimitHeaders(
          this.state,
          tomorrowError.headers,
        );
      }

      const status = tomorrowError.status;

      if (status === 429) {
        this.state.consecutiveRateLimitErrors += 1;

        /**
         * Se o servidor informou que a janela de hora acabou,
         * DESATIVA a key imediatamente.
         */
        if (
          this.state.rateLimitRemainingHour !==
            undefined &&
          this.state.rateLimitRemainingHour <= 0
        ) {
          this.state.hourExhausted = true;
          this.state.cooldownUntil = 0;

          console.warn(
            `[Tomorrow.io] Key ${this.state.keyIndex} esgotou a cota horária. Key desativada nesta execução.`,
          );
        } else {
          const cooldown =
            calculateRateLimitCooldown(
              this.state,
              tomorrowError.retryAfterMs,
            );

          this.state.cooldownUntil =
            Date.now() + cooldown;

          console.warn(
            `[Tomorrow.io] Key ${this.state.keyIndex} recebeu 429. Cooldown: ${cooldown}ms.`,
          );
        }

        throw error;
      }

      if (
        status !== undefined &&
        RETRYABLE_STATUS_CODES.has(status)
      ) {
        const retryDelay = 1_000;

        this.state.cooldownUntil =
          Date.now() + retryDelay;

        console.warn(
          `[Tomorrow.io] Key ${this.state.keyIndex} recebeu HTTP ${status}. Requisição poderá voltar para a fila.`,
        );

        throw error;
      }

      throw error;
    }
  }
}

async function processQueue(
  jobs: WeatherJob[],
  workers: ApiKeyWorker[],
): Promise<Map<string, WeatherTile>> {
  const results = new Map<
    string,
    WeatherTile
  >();

  /**
   * FILA REAL.
   *
   * queue.shift() acontece de forma síncrona.
   *
   * Isso evita o bug anterior onde dois workers
   * encontravam o mesmo índice antes de alguém marcar
   * o bairro como reservado.
   */
  const queue = [...jobs];

  async function workerLoop(
    worker: ApiKeyWorker,
  ) {
    while (true) {
      if (queue.length === 0) {
        return;
      }

      const waitTime =
        worker.waitUntilAvailable;

      /**
       * Key esgotada:
       * não fica esperando.
       *
       * Outro worker pode continuar usando a fila.
       */
      if (!Number.isFinite(waitTime)) {
        return;
      }

      /**
       * Se a key está em cooldown, não pega um bairro
       * e fica segurando esse bairro.
       *
       * Espera no máximo 1 segundo e verifica novamente.
       */
      if (waitTime > 0) {
        await sleep(Math.min(waitTime, 1_000));
        continue;
      }

      /**
       * A retirada da fila é síncrona.
       */
      const job = queue.shift();

      if (!job) {
        return;
      }

      const jobId = String(job.point.id);

      /**
       * Caso algum outro worker já tenha terminado esse bairro.
       */
      if (results.has(jobId)) {
        continue;
      }

      if (
        job.attempts >=
        MAX_ATTEMPTS_PER_NEIGHBORHOOD
      ) {
        if (!results.has(jobId)) {
          results.set(
            jobId,
            createFailedTile(
              job.point,
              `Número máximo de tentativas atingido (${MAX_ATTEMPTS_PER_NEIGHBORHOOD}).`,
            ),
          );
        }

        continue;
      }

      job.attempts += 1;

      console.log(
        `[Tomorrow.io] Key ${worker.keyIndex} → bairro ${job.point.id} (${job.attempts}/${MAX_ATTEMPTS_PER_NEIGHBORHOOD})`,
      );

      try {
        const tile = await worker.execute(
          job.point,
        );

        if (!results.has(jobId)) {
          results.set(jobId, tile);
        }

        console.log(
          `[Tomorrow.io] Bairro ${job.point.id} concluído pela Key ${worker.keyIndex}.`,
        );
      } catch (error) {
        const status = getStatus(error);
        const message = getErrorMessage(error);

        /**
         * 429:
         *
         * Não grava erro definitivo.
         * O bairro volta para a fila e pode ser pego
         * por outra key.
         */
        if (
          status === 429 &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          queue.push(job);

          console.warn(
            `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após 429.`,
          );

          continue;
        }

        /**
         * 500/502/503/504:
         * também podem voltar para a fila.
         */
        if (
          status !== undefined &&
          RETRYABLE_STATUS_CODES.has(status) &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          queue.push(job);

          console.warn(
            `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após HTTP ${status}.`,
          );

          continue;
        }

        /**
         * Timeout/erro de rede:
         * também permitimos nova tentativa enquanto houver
         * tentativas disponíveis.
         */
        if (
          status === undefined &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          queue.push(job);

          console.warn(
            `[Tomorrow.io] Bairro ${job.point.id} voltou para a fila após erro: ${message}`,
          );

          continue;
        }

        /**
         * Chegou ao limite.
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
  }

  /**
   * Os workers rodam em paralelo.
   *
   * Cada um controla uma key diferente.
   */
  await Promise.all(
    workers.map((worker) =>
      workerLoop(worker),
    ),
  );

  /**
   * Se ainda existem bairros sem resultado porque todas
   * as keys ficaram indisponíveis, marcamos rapidamente
   * como falha.
   *
   * Isso evita a execução ficar presa.
   */
  for (const job of jobs) {
    const id = String(job.point.id);

    if (results.has(id)) {
      continue;
    }

    results.set(
      id,
      createFailedTile(
        job.point,
        "Nenhuma API key disponível para processar este bairro nesta execução.",
      ),
    );
  }

  return results;
}

async function saveResults(
  tiles: Map<string, WeatherTile>,
): Promise<{
  updatedCount: number;
  failedCount: number;
}> {
  const db = weatherDb();

  const collectionRef = db.collection(
    WEATHER_COLLECTION,
  );

  /**
   * UMA leitura da coleção.
   *
   * Antes existia um .get() para cada bairro,
   * deixando a gravação muito lenta.
   */
  const existingSnapshot =
    await collectionRef.get();

  const existingIds = new Set<string>();

  for (const doc of existingSnapshot.docs) {
    existingIds.add(doc.id);
  }

  const batch = db.batch();

  let updatedCount = 0;
  let failedCount = 0;

  for (const tile of tiles.values()) {
    const id = String(tile.id);

    const docRef =
      collectionRef.doc(id);

    const failed =
      tile.data === null;

    if (!failed) {
      /**
       * SUCESSO:
       *
       * Cria o documento se ele não existir.
       *
       * Isso resolve diretamente o cenário:
       * "apaguei o Firebase e rodei o cron".
       */
      batch.set(
        docRef,
        {
          id,
          name: tile.name ?? null,
          lat: tile.lat,
          lon: tile.lon,
          data: tile.data,
          timeline: tile.timeline,

          naoVerificado: false,

          /**
           * Remove erros antigos quando uma nova
           * atualização funciona.
           */
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

    /**
     * FALHA:
     *
     * Se o documento já existe, NÃO tocamos em:
     * data
     * timeline
     *
     * Assim preservamos o último dado válido.
     */
    if (existingIds.has(id)) {
      const failedTile =
        tile as FailedWeatherTile;

      batch.set(
        docRef,
        {
          id,
          name: tile.name ?? null,
          lat: tile.lat,
          lon: tile.lon,

          naoVerificado: true,

          lastError:
            tile.error ??
            "Erro desconhecido.",
          lastErrorStatus:
            failedTile.errorStatus ?? null,
          lastErrorAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        },
      );

      continue;
    }

    /**
     * Se o documento realmente não existe,
     * criamos uma estrutura inicial.
     */
    const failedTile =
      tile as FailedWeatherTile;

    batch.set(
      docRef,
      {
        id,
        name: tile.name ?? null,
        lat: tile.lat,
        lon: tile.lon,

        data: null,
        timeline: [],

        naoVerificado: true,

        lastError:
          tile.error ??
          "Erro desconhecido.",
        lastErrorStatus:
          failedTile.errorStatus ?? null,
        lastErrorAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      },
    );
  }

  /**
   * Um único commit.
   */
  await batch.commit();

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

  const metaRef = db
    .collection(WEATHER_META_COLLECTION)
    .doc(WEATHER_META_DOCUMENT);

  const payload: Record<string, unknown> = {
    source: "tomorrow.io",
    neighborhoodCount,
    updatedCount,
    failedCount,

    lastRunAt:
      FieldValue.serverTimestamp(),
  };

  /**
   * Só atualiza updatedAt se realmente houve
   * pelo menos um bairro atualizado.
   *
   * Assim uma execução 100% falha não finge que
   * os dados estão novos.
   */
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

export async function runWeatherUpdate() {
  console.log(
    "[Weather Worker] Iniciando atualização meteorológica...",
  );

  const neighborhoods =
    await loadNeighborhoods();

  console.log(
    `[Weather Worker] ${neighborhoods.length} bairros encontrados.`,
  );

  const apiKeys = getTomorrowKeys();

  console.log(
    `[Weather Worker] ${apiKeys.length} keys disponíveis.`,
  );

  if (apiKeys.length === 0) {
    throw new Error(
      "Nenhuma TOMORROW_API_KEY configurada.",
    );
  }

  const states = apiKeys.map(
    (apiKey, index) =>
      createInitialKeyState(
        apiKey,
        index + 1,
      ),
  );

  const workers = states.map(
    (state) =>
      new ApiKeyWorker(state),
  );

  const jobs: WeatherJob[] =
    neighborhoods.map((point) => ({
      point: {
        id: point.id,
        name: point.name,
        lat: Number(point.lat),
        lon: Number(point.lon),
      },
      attempts: 0,
    }));

  console.log(
    `[Weather Worker] Iniciando fila global com ${workers.length} workers adaptativos.`,
  );

  const results = await processQueue(
    jobs,
    workers,
  );

  const {
    updatedCount,
    failedCount,
  } = await saveResults(results);

  await updateMetadata(
    neighborhoods.length,
    updatedCount,
    failedCount,
  );

  console.log(
    `[Weather Worker] Finalizado. ${updatedCount} bairros atualizados, ${failedCount} falharam.`,
  );

  if (failedCount > 0) {
    await sendDiscordAlert(
      `⚠️ Weather Worker: ${updatedCount}/${neighborhoods.length} bairros atualizados. ${failedCount} falharam.`,
    ).catch((error) => {
      console.error(
        "[Weather Worker] Erro ao enviar alerta Discord:",
        error,
      );
    });
  }

  return {
    ok: true,
    neighborhoodCount: neighborhoods.length,
    updatedCount,
    failedCount,
    tiles: Array.from(results.values()),
  };
}

/**
 * IMPORTANTE:
 *
 * A arquitetura definida é:
 *
 * Frontend -> somente leitura
 * Cron -> único responsável por atualizar
 *
 * Portanto esta função NÃO dispara atualização.
 *
 * Mantemos a função exportada para não quebrar imports antigos,
 * mas ela não executa o worker.
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
  const db = weatherDb();

  const snapshot = await db
    .collection(WEATHER_COLLECTION)
    .get();

  const metaSnapshot = await db
    .collection(WEATHER_META_COLLECTION)
    .doc(WEATHER_META_DOCUMENT)
    .get();

  const tiles: WeatherTile[] =
    snapshot.docs.map((doc) => {
      const data =
        doc.data() as StoredWeatherTile;

      return {
        id: data.id ?? doc.id,
        name: data.name,
        lat: data.lat,
        lon: data.lon,
        data: data.data ?? null,
        timeline: data.timeline ?? [],
        error: data.naoVerificado
          ? data.lastError
          : undefined,
      };
    });

  const hasUnverified =
    snapshot.docs.some((doc) => {
      const data =
        doc.data() as StoredWeatherTile;

      return (
        data.naoVerificado === true ||
        data.data === null
      );
    });

  const meta =
    metaSnapshot.exists
      ? metaSnapshot.data()
      : null;

  const updatedAtValue =
    meta?.updatedAt;

  let updateTimestamp = 0;

  if (
    updatedAtValue &&
    typeof updatedAtValue === "object" &&
    "toMillis" in updatedAtValue &&
    typeof (
      updatedAtValue as {
        toMillis?: unknown;
      }
    ).toMillis === "function"
  ) {
    updateTimestamp = (
      updatedAtValue as {
        toMillis: () => number;
      }
    ).toMillis();
  }

  if (!updateTimestamp && meta?.lastRunAt) {
    const lastRunAt =
      meta.lastRunAt;

    if (
      typeof lastRunAt === "object" &&
      "toMillis" in lastRunAt &&
      typeof (
        lastRunAt as {
          toMillis?: unknown;
        }
      ).toMillis === "function"
    ) {
      updateTimestamp = (
        lastRunAt as {
          toMillis: () => number;
        }
      ).toMillis();
    }
  }

  const now = Date.now();

  const nextUpdate =
    updateTimestamp > 0
      ? updateTimestamp + 60 * 60 * 1000
      : 0;

  let status: GridResponse["status"];

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