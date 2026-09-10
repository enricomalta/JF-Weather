import "dotenv/config";

const LAT = -21.7642;
const LON = -43.3503;

const keys = Array.from({ length: 8 }, (_, index) => {
  const key = process.env[`TOMORROW_API_KEY_${index + 1}`];

  return {
    index: index + 1,
    key,
  };
}).filter(
  (item): item is { index: number; key: string } =>
    Boolean(item.key)
);

if (keys.length === 0) {
  throw new Error(
    "Nenhuma TOMORROW_API_KEY_1...TOMORROW_API_KEY_8 foi encontrada no .env."
  );
}

const API_URL_BASE =
  "https://api.tomorrow.io/v4/timelines";

const body = {
  location: [LAT, LON],
  fields: [
    "temperature",
    "precipitationProbability",
  ],
  timesteps: ["1h"],
  units: "metric",
};

async function testKey(
  index: number,
  apiKey: string
) {
  console.log("");
  console.log("----------------------------------------");
  console.log(`KEY ${index}`);
  console.log("----------------------------------------");

  console.log(
    "API key:",
    `${apiKey.substring(0, 6)}...`
  );

  const url =
    `${API_URL_BASE}?apikey=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const headers = {
      secondLimit: response.headers.get(
        "x-ratelimit-limit-second"
      ),

      secondRemaining: response.headers.get(
        "x-ratelimit-remaining-second"
      ),

      hourLimit: response.headers.get(
        "x-ratelimit-limit-hour"
      ),

      hourRemaining: response.headers.get(
        "x-ratelimit-remaining-hour"
      ),

      dayLimit: response.headers.get(
        "x-ratelimit-limit-day"
      ),

      dayRemaining: response.headers.get(
        "x-ratelimit-remaining-day"
      ),

      retryAfter: response.headers.get(
        "retry-after"
      ),
    };

    console.log("Status:", response.status);

    console.log("Rate limit headers:");
    console.dir(headers, {
      depth: null,
    });

    const text = await response.text();

    if (!response.ok) {
      console.log("Resposta:");
      console.log(text);
    } else {
      console.log("OK");
    }
  } catch (error) {
    console.error("Erro:", error);
  }
}

async function main() {
  console.log("");
  console.log("========================================");
  console.log("TESTE DAS CHAVES TOMORROW.IO");
  console.log("========================================");

  console.log(
    "Chaves encontradas:",
    keys.length
  );

  console.log(
    "Localização:",
    `${LAT},${LON}`
  );

  for (const item of keys) {
    await testKey(
      item.index,
      item.key
    );

    // Evita qualquer interferência
    // do limite por segundo.
    await new Promise((resolve) =>
      setTimeout(resolve, 2500)
    );
  }

  console.log("");
  console.log("========================================");
  console.log("FIM");
  console.log("========================================");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});