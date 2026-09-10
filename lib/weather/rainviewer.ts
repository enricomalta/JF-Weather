import {
  FieldValue,
  weatherDb,
} from "./firebase-admin";

const RAINVIEWER_API_URL =
  "https://api.rainviewer.com/public/weather-maps.json";

const RAINVIEWER_COLLECTION =
  "rainViewerHistory";

const RAINVIEWER_DOCUMENT =
  "juiz-de-fora";

/**
 * Mantemos somente as últimas 12 horas
 * de frames observados.
 */
const HISTORY_RETENTION_MS =
  12 * 60 * 60 * 1000;

export interface RainViewerFrame {
  /**
   * Unix timestamp em segundos.
   */
  time: number;

  /**
   * Caminho fornecido pela API do RainViewer.
   */
  path: string;

  /**
   * URL completa do endpoint de tiles
   * daquele frame.
   */
  url: string;
}

export interface RainViewerHistory {
  frames: RainViewerFrame[];

  /**
   * Momento em que nossa API coletou os frames.
   */
  updatedAt: number;
}

interface RainViewerApiFrame {
  time?: number;
  path?: string;
}

interface RainViewerApiResponse {
  version?: string;
  generated?: number;
  host?: string;
  radar?: {
    past?: RainViewerApiFrame[];
    nowcast?: RainViewerApiFrame[];
  };
}

/**
 * Monta uma URL de tile para um frame.
 *
 * O RainViewer documenta:
 *
 * {host}{path}/{size}/{z}/{x}/{y}/{color}/{options}.png
 *
 * Usamos o esquema Universal Blue (2) e suavização (1).
 */
export function buildRainViewerTileUrl(
  frame: RainViewerFrame,
  z: number,
  x: number,
  y: number,
): string {
  return `${frame.url}/256/${z}/${x}/${y}/2/1_1.png`;
}

/**
 * Monta uma URL de tile centralizada em latitude/longitude.
 *
 * Útil para testes ou widgets.
 */
export function buildRainViewerCoordinateTileUrl(
  frame: RainViewerFrame,
  lat: number,
  lon: number,
  z = 7,
): string {
  return `${frame.url}/256/${z}/${lat}/${lon}/2/1_1.png`;
}

/**
 * Busca os frames disponíveis atualmente no RainViewer.
 */
async function fetchRainViewerFrames(): Promise<{
  frames: RainViewerFrame[];
  generated: number;
}> {
  const response = await fetch(
    RAINVIEWER_API_URL,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      `RainViewer retornou HTTP ${response.status}.`,
    );
  }

  const payload =
    (await response.json()) as RainViewerApiResponse;

  const host =
    payload.host?.trim();

  if (!host) {
    throw new Error(
      "RainViewer não retornou o host dos tiles.",
    );
  }

  const apiFrames =
    payload.radar?.past ?? [];

  const frames: RainViewerFrame[] =
    apiFrames
      .filter(
        (
          frame,
        ): frame is Required<RainViewerApiFrame> =>
          typeof frame.time === "number" &&
          Number.isFinite(frame.time) &&
          typeof frame.path === "string" &&
          frame.path.length > 0,
      )
      .map((frame) => ({
        time: frame.time,
        path: frame.path,
        url: `${host}${frame.path}`,
      }))
      .sort(
        (a, b) =>
          a.time - b.time,
      );

  return {
    frames,
    generated:
      typeof payload.generated === "number"
        ? payload.generated
        : Math.floor(
            Date.now() / 1000,
          ),
  };
}

/**
 * Remove duplicações usando o timestamp
 * do frame como identificador.
 */
function mergeFrames(
  existing: RainViewerFrame[],
  incoming: RainViewerFrame[],
): RainViewerFrame[] {
  const byTime =
    new Map<number, RainViewerFrame>();

  for (const frame of existing) {
    byTime.set(
      frame.time,
      frame,
    );
  }

  for (const frame of incoming) {
    byTime.set(
      frame.time,
      frame,
    );
  }

  return Array.from(
    byTime.values(),
  ).sort(
    (a, b) =>
      a.time - b.time,
  );
}

/**
 * Mantém somente os últimos 12h.
 */
function pruneHistory(
  frames: RainViewerFrame[],
  now = Date.now(),
): RainViewerFrame[] {
  const cutoffSeconds =
    Math.floor(
      (now - HISTORY_RETENTION_MS) /
        1000,
    );

  return frames.filter(
    (frame) =>
      frame.time >= cutoffSeconds,
  );
}

/**
 * Lê o histórico salvo no Firestore.
 */
export async function readRainViewerHistory(): Promise<RainViewerHistory> {
  const db = weatherDb();

  const docRef = db
    .collection(
      RAINVIEWER_COLLECTION,
    )
    .doc(
      RAINVIEWER_DOCUMENT,
    );

  const snapshot =
    await docRef.get();

  if (!snapshot.exists) {
    return {
      frames: [],
      updatedAt: 0,
    };
  }

  const data =
    snapshot.data() as Partial<RainViewerHistory>;

  const frames =
    Array.isArray(data.frames)
      ? data.frames.filter(
          (
            frame,
          ): frame is RainViewerFrame =>
            typeof frame === "object" &&
            frame !== null &&
            typeof (
              frame as RainViewerFrame
            ).time === "number" &&
            typeof (
              frame as RainViewerFrame
            ).path === "string" &&
            typeof (
              frame as RainViewerFrame
            ).url === "string",
        )
      : [];

  return {
    frames: pruneHistory(
      frames,
    ),
    updatedAt:
      typeof data.updatedAt ===
      "number"
        ? data.updatedAt
        : 0,
  };
}

/**
 * Atualiza o histórico:
 *
 * 1. Busca os frames atuais do RainViewer.
 * 2. Lê o histórico anterior.
 * 3. Junta os frames.
 * 4. Remove duplicados.
 * 5. Remove tudo que passou de 12h.
 * 6. Persiste no Firestore.
 */
export async function updateRainViewerHistory(): Promise<{
  ok: boolean;
  fetchedFrames: number;
  storedFrames: number;
  oldestFrame: number | null;
  newestFrame: number | null;
}> {
  console.log(
    "[RainViewer] Iniciando atualização do histórico...",
  );

  const {
    frames: incomingFrames,
    generated,
  } = await fetchRainViewerFrames();

  if (incomingFrames.length === 0) {
    console.warn(
      "[RainViewer] Nenhum frame de radar retornado pela API.",
    );

    return {
      ok: false,
      fetchedFrames: 0,
      storedFrames: 0,
      oldestFrame: null,
      newestFrame: null,
    };
  }

  console.log(
    `[RainViewer] ${incomingFrames.length} frames recebidos.`,
  );

  const current =
    await readRainViewerHistory();

  const merged =
    mergeFrames(
      current.frames,
      incomingFrames,
    );

  const frames =
    pruneHistory(
      merged,
      Date.now(),
    );

  const db = weatherDb();

  const docRef = db
    .collection(
      RAINVIEWER_COLLECTION,
    )
    .doc(
      RAINVIEWER_DOCUMENT,
    );

  await docRef.set(
    {
      provider:
        "rainviewer",
      location:
        "juiz-de-fora",
      frames,
      frameCount:
        frames.length,
      oldestFrame:
        frames.length > 0
          ? frames[0].time
          : null,
      newestFrame:
        frames.length > 0
          ? frames[
              frames.length - 1
            ].time
          : null,
      rainViewerGenerated:
        generated,
      updatedAt:
        Date.now(),
      firestoreUpdatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    },
  );

  console.log(
    `[RainViewer] Histórico salvo: ${frames.length} frames.`,
  );

  return {
    ok: true,
    fetchedFrames:
      incomingFrames.length,
    storedFrames:
      frames.length,
    oldestFrame:
      frames.length > 0
        ? frames[0].time
        : null,
    newestFrame:
      frames.length > 0
        ? frames[
            frames.length - 1
          ].time
        : null,
  };
}