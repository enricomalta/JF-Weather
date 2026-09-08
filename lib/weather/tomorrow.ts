import {
  FieldValue,
  WEATHER_COLLECTION,
  WEATHER_META_COLLECTION,
  WEATHER_META_DOCUMENT,
  sendDiscordAlert,
  serializeFirestore,
  weatherDb,
} from "./firebase-admin";

import {
  loadNeighborhoods,
  type NeighborhoodPoint,
} from "./neighborhoods";

import type {
  GridResponse,
  TimelinePoint,
  WeatherData,
  WeatherTile,
} from "./types";

const TIMELINE_URL =
  "https://api.tomorrow.io/v4/timelines";

const HOURS = 12;

const INITIAL_REQUEST_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_REQUESTS_PER_HOUR_PER_KEY = 20;
const EXPECTED_API_KEYS = 8;

const MAX_ATTEMPTS_PER_NEIGHBORHOOD = 4;

const RATE_LIMIT_COOLDOWN_MS = 5000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60000;

const SERVER_ERROR_RETRY_BASE_MS = 2000;

const TOMORROW_FIELDS = [
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
];

interface ApiKeyState {
  key: string;
  index: number;
  requestsThisHour: number;
  hourStartedAt: number;
  lastRequestAt: number;
  cooldownUntil: number;
  consecutiveRateLimits: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitResponses: number;
  lastStatus?: number;
  rateLimitLimitSecond?: string;
  rateLimitRemainingSecond?: string;
  rateLimitLimitHour?: string;
  rateLimitRemainingHour?: string;
}

interface NeighborhoodJob {
  point: NeighborhoodPoint;
  attempts: number;
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
  retryAfterMs?: number;
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
      key
        ? null
        : `TOMORROW_API_KEY_${index + 1}`,
    )
    .filter(
      (name): name is string =>
        Boolean(name),
    );

  if (missing.length) {
    throw new Error(
      `Variáveis do Tomorrow.io ausentes: ${missing.join(
        ", ",
      )}`,
    );
  }

  return keys as string[];
}

function createKeyStates(): ApiKeyState[] {
  return getApiKeys().map(
    (key, index) => ({
      key,
      index: index + 1,
      requestsThisHour: 0,
      hourStartedAt: Date.now(),
      lastRequestAt: 0,
      cooldownUntil: 0,
      consecutiveRateLimits: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitResponses: 0,
    }),
  );
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

    console.log(
      `[Tomorrow.io] Key ${state.index}: contador horário resetado.`,
    );
  }
}

function createTomorrowError(
  message: string,
  status?: number,
  retryAfterMs?: number,
): TomorrowError {
  const error =
    new Error(message) as TomorrowError;

  error.status = status;
  error.retryAfterMs = retryAfterMs;

  return error;
}

function parseRetryAfter(
  value: string | null,
): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (
    Number.isFinite(seconds) &&
    seconds >= 0
  ) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(
      0,
      date - Date.now(),
    );
  }

  return undefined;
}

function normalize(
  values: Record<string, number>,
  timestamp: number,
): WeatherData {
  return {
    temperature:
      values.temperature ?? 0,

    humidity:
      values.humidity ?? 0,

    precipitation:
      values.precipitationIntensity ?? 0,

    precipitationProbability:
      values.precipitationProbability ?? 0,

    windSpeed:
      values.windSpeed ?? 0,

    windDirection:
      values.windDirection ?? 0,

    cloudCover:
      values.cloudCover ?? 0,

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
        item.values
          ?.precipitationIntensity ?? 0,

      probability:
        item.values
          ?.precipitationProbability ?? 0,
    }))
    .filter((item) =>
      Number.isFinite(item.time),
    );
}

function sleep(
  ms: number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms),
  );
}

async function requestTimeline(
  point: NeighborhoodPoint,
  key: string,
): Promise<{
  data: TomorrowTimelineResponse;
  headers: Headers;
}> {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => {
      controller.abort();
    },
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      TIMELINE_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        signal: controller.signal,

        body: JSON.stringify({
          location: `${point.lat},${point.lon}`,

          fields: TOMORROW_FIELDS,

          timesteps: ["1h"],

          startTime: "now",

          endTime:
            "nowPlus12h",

          units: "metric",

          apikey: key,
        }),
      },
    );

    if (!response.ok) {
      const retryAfterMs =
        parseRetryAfter(
          response.headers.get(
            "Retry-After",
          ),
        );

      throw createTomorrowError(
        `Tomorrow.io respondeu ${response.status}`,
        response.status,
        retryAfterMs,
      );
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
        "Timeout ao consultar Tomorrow.io",
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function updateRateLimitHeaders(
  state: ApiKeyState,
  headers: Headers,
) {
  state.rateLimitLimitSecond =
    headers.get(
      "X-RateLimit-Limit-second",
    ) ?? undefined;

  state.rateLimitRemainingSecond =
    headers.get(
      "X-RateLimit-Remaining-second",
    ) ?? undefined;

  state.rateLimitLimitHour =
    headers.get(
      "X-RateLimit-Limit-hour",
    ) ?? undefined;

  state.rateLimitRemainingHour =
    headers.get(
      "X-RateLimit-Remaining-hour",
    ) ?? undefined;
}

function calculateRateLimitCooldown(
  state: ApiKeyState,
  retryAfterMs?: number,
): number {
  if (
    retryAfterMs !== undefined
  ) {
    return Math.min(
      Math.max(
        retryAfterMs,
        RATE_LIMIT_COOLDOWN_MS,
      ),
      MAX_RATE_LIMIT_COOLDOWN_MS,
    );
  }

  const multiplier = Math.max(
    0,
    state.consecutiveRateLimits - 1,
  );

  return Math.min(
    RATE_LIMIT_COOLDOWN_MS *
      Math.pow(2, multiplier),
    MAX_RATE_LIMIT_COOLDOWN_MS,
  );
}

class ApiKeyWorker {
  constructor(
    private readonly state: ApiKeyState,
  ) {}

  get keyIndex() {
    return this.state.index;
  }

  get available() {
    resetHourlyCounterIfNeeded(
      this.state,
    );

    return (
      this.state.requestsThisHour <
        MAX_REQUESTS_PER_HOUR_PER_KEY &&
      Date.now() >=
        this.state.cooldownUntil
    );
  }

  get waitUntilAvailable() {
    resetHourlyCounterIfNeeded(
      this.state,
    );

    if (
      this.state.requestsThisHour >=
      MAX_REQUESTS_PER_HOUR_PER_KEY
    ) {
      return Infinity;
    }

    return Math.max(
      0,
      this.state.cooldownUntil -
        Date.now(),

      this.state.lastRequestAt +
        INITIAL_REQUEST_INTERVAL_MS -
        Date.now(),
    );
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
      throw createTomorrowError(
        `Key ${this.state.index} atingiu o limite operacional de ${MAX_REQUESTS_PER_HOUR_PER_KEY} requests/hora`,
      );
    }

    const waitTime =
      this.waitUntilAvailable;

    if (
      Number.isFinite(waitTime) &&
      waitTime > 0
    ) {
      await sleep(waitTime);
    }

    this.state.lastRequestAt =
      Date.now();

    this.state.requestsThisHour += 1;

    console.log(
      `[Tomorrow.io] Key ${this.state.index} → bairro ${point.id} (${this.state.requestsThisHour}/${MAX_REQUESTS_PER_HOUR_PER_KEY})`,
    );

    try {
      const response =
        await requestTimeline(
          point,
          this.state.key,
        );

      updateRateLimitHeaders(
        this.state,
        response.headers,
      );

      this.state.successfulRequests +=
        1;

      this.state.lastStatus = 200;

      this.state.consecutiveRateLimits =
        0;

      this.state.cooldownUntil = 0;

      const timelineData =
        response.data.data
          ?.timelines?.[0];

      const intervals =
        timelineData?.intervals ?? [];

      if (!intervals.length) {
        throw createTomorrowError(
          "Tomorrow.io não retornou intervalos para o bairro",
        );
      }

      const firstInterval =
        intervals[0];

      const timestamp =
        Date.parse(
          firstInterval.startTime ??
            new Date().toISOString(),
        );

      return {
        id: point.id,
        name: point.name,
        lat: point.lat,
        lon: point.lon,

        data: normalize(
          firstInterval.values ??
            {},
          timestamp,
        ),

        timeline:
          buildTimeline(
            intervals,
          ),
      };
    } catch (error) {
      if (
        error instanceof Error
      ) {
        const tomorrowError =
          error as TomorrowError;

        this.state.lastStatus =
          tomorrowError.status;

        if (
          tomorrowError.status ===
          429
        ) {
          this.state.rateLimitResponses +=
            1;

          this.state.consecutiveRateLimits +=
            1;

          const cooldown =
            calculateRateLimitCooldown(
              this.state,
              tomorrowError.retryAfterMs,
            );

          this.state.cooldownUntil =
            Date.now() + cooldown;

          console.warn(
            `[Tomorrow.io] Key ${this.state.index} recebeu 429. Cooldown: ${cooldown}ms.`,
          );

          console.warn(
            `[Tomorrow.io] Key ${this.state.index} headers:`,
            {
              secondLimit:
                this.state
                  .rateLimitLimitSecond,

              secondRemaining:
                this.state
                  .rateLimitRemainingSecond,

              hourLimit:
                this.state
                  .rateLimitLimitHour,

              hourRemaining:
                this.state
                  .rateLimitRemainingHour,
            },
          );
        }

        this.state.failedRequests +=
          1;
      }

      throw error;
    }
  }
}

/**
 * Busca um job que ainda não esteja sendo
 * processado por outro worker.
 */
function getNextJob(
  jobs: NeighborhoodJob[],
  results: Map<string, WeatherTile>,
  claimedJobs: Set<string>,
): NeighborhoodJob | undefined {
  const job = jobs.find((candidate) => {
    const id = String(
      candidate.point.id,
    );

    return (
      !results.has(id) &&
      !claimedJobs.has(id) &&
      candidate.attempts <
        MAX_ATTEMPTS_PER_NEIGHBORHOOD
    );
  });

  return job;
}

function createFailedTile(
  job: NeighborhoodJob,
  message: string,
): WeatherTile {
  return {
    id: job.point.id,
    name: job.point.name,
    lat: job.point.lat,
    lon: job.point.lon,
    data: null,
    timeline: [],
    error: message,
  };
}

async function processQueue(
  jobs: NeighborhoodJob[],
  workers: ApiKeyWorker[],
): Promise<WeatherTile[]> {
  const results =
    new Map<string, WeatherTile>();

  /**
   * IMPORTANTE:
   *
   * Esse Set impede que dois workers
   * peguem o mesmo bairro simultaneamente.
   */
  const claimedJobs =
    new Set<string>();

  async function workerLoop(
    worker: ApiKeyWorker,
  ) {
    while (true) {
      /**
       * Primeiro procura um bairro livre.
       */
      const job =
        getNextJob(
          jobs,
          results,
          claimedJobs,
        );

      if (!job) {
        break;
      }

      const jobId =
        String(job.point.id);

      /**
       * RESERVA IMEDIATAMENTE.
       *
       * Isso acontece antes de qualquer await.
       * Portanto outro worker não consegue
       * pegar o mesmo bairro.
       */
      claimedJobs.add(jobId);

      job.attempts += 1;

      try {
        /**
         * Se essa key estiver temporariamente
         * indisponível, libera o bairro antes
         * de esperar.
         */
        const waitTime =
          worker.waitUntilAvailable;

        if (
          !Number.isFinite(waitTime)
        ) {
          claimedJobs.delete(jobId);
          break;
        }

        if (waitTime > 0) {
          await sleep(waitTime);
        }

        /**
         * Depois do sleep, a key pode ter
         * entrado em cooldown por outro motivo.
         *
         * Se isso acontecer, libera o bairro
         * para outro worker.
         */
        if (!worker.available) {
          claimedJobs.delete(jobId);
          continue;
        }

        const tile =
          await worker.execute(
            job.point,
          );

        /**
         * Só agora o bairro é considerado
         * definitivamente concluído.
         */
        results.set(
          jobId,
          tile,
        );

        claimedJobs.delete(
          jobId,
        );

        console.log(
          `[Tomorrow.io] Bairro ${job.point.id} concluído pela Key ${worker.keyIndex}.`,
        );
      } catch (error) {
        /**
         * Libera o bairro imediatamente.
         *
         * Assim ele pode ser processado
         * por outra key.
         */
        claimedJobs.delete(
          jobId,
        );

        const tomorrowError =
          error instanceof Error
            ? (error as TomorrowError)
            : undefined;

        const status =
          tomorrowError?.status;

        const message =
          error instanceof Error
            ? error.message
            : "Falha ao consultar Tomorrow.io";

        /**
         * 429:
         *
         * Não finaliza o bairro.
         * Ele volta para a fila.
         */
        if (
          status === 429 &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          console.warn(
            `[Weather Worker] Bairro ${job.point.id} voltou para a fila após 429. Tentativa ${job.attempts}/${MAX_ATTEMPTS_PER_NEIGHBORHOOD}.`,
          );

          continue;
        }

        /**
         * Erros temporários.
         */
        const retryable =
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          status === undefined;

        if (
          retryable &&
          job.attempts <
            MAX_ATTEMPTS_PER_NEIGHBORHOOD
        ) {
          const retryDelay =
            Math.min(
              SERVER_ERROR_RETRY_BASE_MS *
                Math.pow(
                  2,
                  job.attempts - 1,
                ),
              MAX_RATE_LIMIT_COOLDOWN_MS,
            );

          console.warn(
            `[Weather Worker] Bairro ${job.point.id}: ${message}. Retry em ${retryDelay}ms.`,
          );

          await sleep(
            retryDelay,
          );

          continue;
        }

        /**
         * Erro definitivo ou acabou o número
         * máximo de tentativas.
         *
         * IMPORTANTE:
         * esse resultado NÃO será gravado como
         * data:null por cima do Firestore.
         */
        console.error(
          `[Weather Worker] Bairro ${job.point.id} falhou definitivamente: ${message}`,
        );

        results.set(
          jobId,
          createFailedTile(
            job,
            message,
          ),
        );
      }
    }
  }

  /**
   * Todos os workers começam juntos.
   */
  await Promise.all(
    workers.map(
      (worker) =>
        workerLoop(worker),
    ),
  );

  /**
   * Qualquer bairro que não tenha sido
   * concluído recebe um resultado de falha
   * apenas para controle interno.
   */
  for (const job of jobs) {
    const id =
      String(job.point.id);

    if (results.has(id)) {
      continue;
    }

    results.set(
      id,
      createFailedTile(
        job,
        "Nenhuma API key disponível para concluir o bairro nesta execução.",
      ),
    );
  }

  return jobs.map(
    (job) =>
      results.get(
        String(job.point.id),
      )!,
  );
}

/**
 * Salva os resultados sem destruir
 * dados válidos existentes.
 *
 * SUCESSO:
 *   substitui os dados meteorológicos.
 *
 * FALHA:
 *   mantém data/timeline antigas
 *   e apenas marca naoVerificado.
 */
async function saveResults(
  results: WeatherTile[],
) {
  const db = weatherDb();

  const batch = db.batch();

  for (const tile of results) {
    const docRef = db
      .collection(
        WEATHER_COLLECTION,
      )
      .doc(String(tile.id));

    /**
     * Não podemos fazer get() usando o mesmo
     * batch. Primeiro buscamos o documento atual.
     */
    const existingSnapshot =
      await docRef.get();

    const existing =
      existingSnapshot.exists
        ? existingSnapshot.data()
        : undefined;

    const hasNewData =
      tile.data !== null;

    if (hasNewData) {
      /**
       * SUCESSO:
       * grava os novos dados.
       */
      batch.set(
        docRef,
        {
          ...tile,

          naoVerificado: false,

          lastError: null,

          lastErrorStatus: null,

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        },
      );
    } else {
      /**
       * FALHA:
       *
       * NÃO colocamos:
       *
       * data: null
       * timeline: []
       *
       * Porque isso destruiria o último
       * dado meteorológico válido.
       */
      batch.set(
        docRef,
        {
          id: tile.id,
          name:
            existing?.name ??
            tile.name,

          lat:
            existing?.lat ??
            tile.lat,

          lon:
            existing?.lon ??
            tile.lon,

          naoVerificado: true,

          lastError:
            tile.error ??
            "Falha ao consultar Tomorrow.io",

          lastErrorStatus:
            undefined,

          lastErrorAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        },
      );
    }
  }

  /**
   * Meta da execução.
   */
  batch.set(
    db
      .collection(
        WEATHER_META_COLLECTION,
      )
      .doc(
        WEATHER_META_DOCUMENT,
      ),
    {
      updatedAt:
        FieldValue.serverTimestamp(),

      neighborhoodCount:
        results.length,

      source:
        "tomorrow.io",
    },
    {
      merge: true,
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
        (tile.data
          ?.precipitation ?? 0) > 0,
    )
    .map(
      (tile) => tile.name,
    );

  if (!alerts.length) {
    return 0;
  }

  await sendDiscordAlert(
    `JF Radar: chuva agora ou na próxima hora em ${alerts.join(
      ", ",
    )}.

Accesse nossa plataforma para mais detalhes: https://jf-weather.vercel.app/`,
  );

  return alerts.length;
}

export async function runWeatherUpdate() {
  const startedAt =
    Date.now();

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

  const jobs: NeighborhoodJob[] =
    points.map((point) => ({
      point,
      attempts: 0,
    }));

  const workers =
    states.map(
      (state) =>
        new ApiKeyWorker(state),
    );

  console.log(
    `[Weather Worker] Iniciando fila global com ${workers.length} workers adaptativos.`,
  );

  const results =
    await processQueue(
      jobs,
      workers,
    );

  await saveResults(
    results,
  );

  const alerts =
    await sendRainAlerts(
      results,
    );

  /**
   * Aqui "successful" significa que
   * conseguimos dados novos nesta execução.
   *
   * Um bairro que possui dados antigos,
   * mas falhou agora, não entra como sucesso.
   */
  const successful =
    results.filter(
      (tile) =>
        tile.data !== null,
    ).length;

  const failed =
    results.length -
    successful;

  const duration =
    Date.now() - startedAt;

  const keyStats =
    states.map(
      (state) => ({
        key: state.index,

        requests:
          state.requestsThisHour,

        successful:
          state.successfulRequests,

        failed:
          state.failedRequests,

        rateLimits:
          state.rateLimitResponses,

        lastStatus:
          state.lastStatus,

        cooldownUntil:
          state.cooldownUntil ||
          null,

        rateLimitLimitSecond:
          state.rateLimitLimitSecond,

        rateLimitRemainingSecond:
          state.rateLimitRemainingSecond,

        rateLimitLimitHour:
          state.rateLimitLimitHour,

        rateLimitRemainingHour:
          state.rateLimitRemainingHour,
      }),
    );

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

  /**
   * IMPORTANTE:
   *
   * readWeather NÃO dispara mais
   * runWeatherUpdate().
   *
   * Atualização meteorológica é responsabilidade
   * exclusiva do cron.
   */
  const snapshot =
    await db
      .collection(
        WEATHER_COLLECTION,
      )
      .get();

  const tiles =
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

  const metaSnapshot =
    await db
      .collection(
        WEATHER_META_COLLECTION,
      )
      .doc(
        WEATHER_META_DOCUMENT,
      )
      .get();

  const meta =
    metaSnapshot.exists
      ? serializeFirestore(
          metaSnapshot.data(),
        )
      : null;

  const timeline =
    tiles
      .flatMap(
        (tile) =>
          tile.timeline ?? [],
      )
      .sort(
        (a, b) =>
          a.time - b.time,
      );

  const uniqueTimeline =
    timeline.filter(
      (item, index, array) =>
        index ===
        array.findIndex(
          (other) =>
            other.time ===
            item.time,
        ),
    );

  const updateTimestamp =
    meta?.updatedAt
      ? new Date(
          meta.updatedAt,
        ).getTime()
      : 0;

  return {
    tiles,

    timeline:
      uniqueTimeline,

    timestamp:
      Date.now(),

    updateTimestamp,

    nextUpdate:
      updateTimestamp +
      60 * 60 * 1000,

    status:
      tiles.length === 0
        ? "error"
        : tiles.some(
              (tile) =>
                tile.data === null,
            )
          ? "partial"
          : "success",

    message:
      tiles.some(
        (tile) =>
          tile.data === null,
      )
        ? "Alguns bairros não puderam ser atualizados."
        : undefined,
  };
}