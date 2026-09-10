import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

const REQUEST_INTERVAL_MS = 2_200;

const keys = Array.from(
  { length: 8 },
  (_, index) => {
    const key =
      process.env[
        `TOMORROW_API_KEY_${index + 1}`
      ];

    return {
      index: index + 1,
      key,
    };
  }
).filter(
  (
    item
  ): item is {
    index: number;
    key: string;
  } => Boolean(item.key)
);

if (keys.length !== 8) {
  throw new Error(
    `Esperadas 8 keys, mas foram encontradas ${keys.length}.`
  );
}

interface Neighborhood {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

function coordinates(
  value: unknown
): Array<[number, number]> {
  if (!Array.isArray(value)) {
    return [];
  }

  if (
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    return [
      value as [number, number],
    ];
  }

  return value.flatMap(
    coordinates
  );
}

function loadNeighborhoods(): Neighborhood[] {
  const file = path.join(
    process.cwd(),
    "public/geo/bairros-jf.geojson"
  );

  if (!fs.existsSync(file)) {
    throw new Error(
      `GeoJSON não encontrado: ${file}`
    );
  }

  const geo = JSON.parse(
    fs.readFileSync(file, "utf8")
  );

  return geo.features
    .map(
      (
        feature: any,
        index: number
      ) => {
        const points =
          coordinates(
            feature.geometry?.coordinates
          );

        const [lon, lat] =
          points
            .reduce(
              (
                sum: [
                  number,
                  number
                ],
                point: [
                  number,
                  number
                ]
              ) => [
                sum[0] + point[0],
                sum[1] + point[1],
              ],
              [0, 0]
            )
            .map(
              (value: number) =>
                value /
                Math.max(
                  points.length,
                  1
                )
            );

        const properties =
          feature.properties ?? {};

        const name = String(
          properties.name ??
            properties.nome ??
            properties.NOME ??
            properties.bairro ??
            `Bairro ${index + 1}`
        );

        return {
          id: String(
            feature.id ?? index
          ),
          name,
          lat,
          lon,
        };
      }
    )
    .filter(
      (point: Neighborhood) =>
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon)
    );
}

const neighborhoods =
  loadNeighborhoods();

if (neighborhoods.length === 0) {
  throw new Error(
    "Nenhum bairro encontrado no GeoJSON."
  );
}

function sleep(ms: number) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function getHeaders(
  response: Response
) {
  return {
    secondLimit:
      response.headers.get(
        "x-ratelimit-limit-second"
      ),

    secondRemaining:
      response.headers.get(
        "x-ratelimit-remaining-second"
      ),

    hourLimit:
      response.headers.get(
        "x-ratelimit-limit-hour"
      ),

    hourRemaining:
      response.headers.get(
        "x-ratelimit-remaining-hour"
      ),

    retryAfter:
      response.headers.get(
        "retry-after"
      ),
  };
}

async function requestNeighborhood(
  neighborhood: Neighborhood,
  requestNumber: number,
  keyIndex: number,
  apiKey: string
) {
  const startedAt =
    Date.now();

  const body = {
    location: [
      neighborhood.lat,
      neighborhood.lon,
    ],

    fields: [
      "temperature",
      "precipitationProbability",
    ],

    timesteps: ["1h"],

    units: "metric",
  };

  try {
    const response =
      await fetch(
        `https://api.tomorrow.io/v4/timelines?apikey=${encodeURIComponent(
          apiKey
        )}`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",
            accept:
              "application/json",
          },

          body: JSON.stringify(
            body
          ),
        }
      );

    const elapsed =
      Date.now() - startedAt;

    const headers =
      getHeaders(response);

    console.log(
      `[${String(
        requestNumber
      ).padStart(
        3,
        "0"
      )}/${neighborhoods.length}] ` +
        `KEY ${keyIndex} | ` +
        `${neighborhood.name} | ` +
        `${response.status} | ` +
        `${elapsed}ms | ` +
        `hour=${headers.hourRemaining ?? "?"}/${headers.hourLimit ?? "?"} | ` +
        `second=${headers.secondRemaining ?? "?"}/${headers.secondLimit ?? "?"}`
    );

    if (!response.ok) {
      const text =
        await response.text();

      console.log(
        `    RESPOSTA: ${text.substring(
          0,
          500
        )}`
      );
    }

    return {
      success:
        response.status >=
          200 &&
        response.status < 300,

      rateLimited:
        response.status ===
        429,

      error:
        response.status !==
          429 &&
        (response.status < 200 ||
          response.status >= 300),
    };
  } catch (error) {
    console.log(
      `[${String(
        requestNumber
      ).padStart(
        3,
        "0"
      )}/${neighborhoods.length}] ` +
        `KEY ${keyIndex} | ` +
        `${neighborhood.name} | ` +
        `ERRO DE REDE`
    );

    console.error(error);

    return {
      success: false,
      rateLimited: false,
      error: true,
    };
  }
}

async function main() {
  const total =
    neighborhoods.length;

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "TESTE COMPLETO — 8 KEYS"
  );
  console.log(
    "========================================"
  );

  console.log(
    `Bairros encontrados: ${total}`
  );

  console.log(
    `Keys: ${keys.length}`
  );

  console.log(
    `Intervalo: ${REQUEST_INTERVAL_MS}ms`
  );

  console.log(
    `Tempo estimado: ${(
      ((total - 1) *
        REQUEST_INTERVAL_MS) /
      60000
    ).toFixed(1)} minutos`
  );

  console.log("");

  console.log(
    "Rotação:"
  );

  console.log(
    "KEY 1 → KEY 2 → KEY 3 → KEY 4 → KEY 5 → KEY 6 → KEY 7 → KEY 8 → ..."
  );

  console.log("");

  console.log(
    "Origem: PC local"
  );

  console.log(
    "Proxy: nenhum"
  );

  console.log("");

  console.log(
    "Iniciando em 3 segundos..."
  );

  await sleep(3000);

  let success = 0;
  let rateLimited = 0;
  let errors = 0;

  const keyStats =
    keys.map(
      (key) => ({
        keyIndex:
          key.index,

        success: 0,

        rateLimited: 0,

        errors: 0,
      })
    );

  for (
    let i = 0;
    i < total;
    i++
  ) {
    const neighborhood =
      neighborhoods[i];

    const keyPosition =
      i % keys.length;

    const currentKey =
      keys[keyPosition];

    const result =
      await requestNeighborhood(
        neighborhood,
        i + 1,
        currentKey.index,
        currentKey.key
      );

    const stats =
      keyStats[keyPosition];

    if (result.success) {
      success++;
      stats.success++;
    } else if (
      result.rateLimited
    ) {
      rateLimited++;
      stats.rateLimited++;
    } else {
      errors++;
      stats.errors++;
    }

    if (i < total - 1) {
      await sleep(
        REQUEST_INTERVAL_MS
      );
    }
  }

  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    "RESULTADO FINAL"
  );

  console.log(
    "========================================"
  );

  console.log(
    `Bairros:      ${total}`
  );

  console.log(
    `Sucesso:      ${success}`
  );

  console.log(
    `Rate limit:   ${rateLimited}`
  );

  console.log(
    `Outros erros: ${errors}`
  );

  console.log("");

  console.log(
    "RESULTADO POR KEY"
  );

  console.log(
    "----------------------------------------"
  );

  for (
    const stats of keyStats
  ) {
    console.log(
      `KEY ${stats.keyIndex}: ` +
        `${stats.success} OK | ` +
        `${stats.rateLimited} × 429 | ` +
        `${stats.errors} erros`
    );
  }

  console.log("");

  console.log(
    "========================================"
  );

  console.log("FIM");

  console.log(
    "========================================"
  );
}

main().catch(
  (error) => {
    console.error("");
    console.error(
      "ERRO FATAL:"
    );
    console.error(error);

    process.exit(1);
  }
);