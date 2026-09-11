"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Crosshair, LocateFixed, Pause, Play, RefreshCw } from "lucide-react";
import Image from "next/image";
import type { RainViewerFrame } from "@/lib/weather/rainviewer";
import { doc, onSnapshot } from "firebase/firestore";
import { clientDb } from "@/lib/firebase-client";

const WeatherMap = dynamic(
  () =>
    import("@/components/weather/weather-map").then(
      (module) => module.WeatherMap,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="map-canvas map-loading">Carregando mapa…</div>
    ),
  },
);
import type {
  GridResponse,
  TimelinePoint,
  WeatherData,
  WeatherTile,
} from "@/lib/weather/types";

const empty: GridResponse = {
  tiles: [],
  timeline: [],
  timestamp: 0,
  updateTimestamp: 0,
  nextUpdate: 0,
  status: "error",
  message: "Aguardando os dados para iniciar o monitoramento.",
};
const CACHE_KEY = "jf-radar-cache-previsao";
const CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hora
const format = (time: number) =>
  new Date(time).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
const intensity = (value: number) =>
  value <= 0
    ? "Sem chuva"
    : value < 2.5
      ? "Chuva fraca"
      : value < 7.6
        ? "Chuva moderada"
        : "Chuva forte";

export default function Page() {
  const [data, setData] = useState<GridResponse>(empty);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedRain, setSelectedRain] = useState<WeatherData | null>(null);
  const [selectedTile, setSelectedTile] = useState<WeatherTile | null>(null);
  const [radarIndex, setRadarIndex] = useState(0);
  const [forecastIndex, setForecastIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [rainViewerFrames, setRainViewerFrames] = useState<RainViewerFrame[]>(
    [],
  );
  const [rainViewerLoading, setRainViewerLoading] = useState(true);
  async function refresh(force = false) {
    setLoading(true);
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (!force && cached) {
        const parsed = JSON.parse(cached) as {
          savedAt: number;
          data: GridResponse;
        };
        if (Date.now() - parsed.savedAt < CACHE_TTL) {
          setData(parsed.data);
          setLoading(false);
          return;
        }
      }
      const response = await fetch(`/api/weather/grid?refresh=${Date.now()}`, {
        cache: "no-store",
      });
      const next = (await response.json()) as GridResponse;
      setData(next);
      if (next.status !== "error")
        sessionStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ savedAt: Date.now(), data: next }),
        );
    } catch {
      setData(empty);
    } finally {
      setLoading(false);
    }
  }


  useEffect(() => {
    refresh();

    const radarRef = doc(
      clientDb,
      "rainViewerHistory",
      "juiz-de-fora",
    );

    const unsubscribe = onSnapshot(
      radarRef,
      (snapshot) => {
        const snapshotData = snapshot.data();

        const frames = Array.isArray(snapshotData?.frames)
          ? (snapshotData.frames as RainViewerFrame[])
          : [];

        setRainViewerFrames(frames);

        if (frames.length > 0) {
          setRadarIndex(frames.length - 1);
        }

        setRainViewerLoading(false);
      },
      (error) => {
        console.error(
          "[RainViewer] Listener Firestore:",
          error,
        );

        setRainViewerLoading(false);
      },
    );

    return () => unsubscribe();
  }, []);
  

  const forecastTimeline = selectedTile?.timeline ?? [];

  const activeTimeline = selected
    ? forecastTimeline
    : [];

  const activeRadarFrame =
    rainViewerFrames.length > 0
      ? rainViewerFrames[radarIndex] ??
        rainViewerFrames[rainViewerFrames.length - 1]
      : null;

  const forecastPlaybackLength = activeTimeline.length;

  useEffect(() => {
    if (!playing || forecastPlaybackLength < 2) return;

    const timer = window.setInterval(() => {
      setForecastIndex((value) =>
        value >= forecastPlaybackLength - 1 ? 0 : value + 1,
      );
    }, 900);

    return () => window.clearInterval(timer);
  }, [playing, forecastPlaybackLength]);
  const rain = selectedRain ?? data.tiles.find((tile) => tile.data)?.data ?? null;
  const currentPoint: TimelinePoint | null =
    activeTimeline[forecastIndex] ?? null;
  const radarLatestFrame =
    rainViewerFrames.length > 0
      ? rainViewerFrames[rainViewerFrames.length - 1]
      : null;

  const radarUpdatedAt = radarLatestFrame
    ? radarLatestFrame.time * 1000
    : null;

  const rainViewerLatestFrame =
    rainViewerFrames.length > 0
      ? rainViewerFrames[rainViewerFrames.length - 1]
      : null;

  const status = loading
    ? "ATUALIZANDO…"
    : data.status === "error"
      ? "SERVIÇO INDISPONÍVEL"
      : `PREVISÃO ATUALIZADO ${format(data.updateTimestamp)}`;
  const detailValue = currentPoint?.precipitation ?? rain?.precipitation ?? 0;
  const detailProbability = currentPoint?.probability ?? rain?.precipitationProbability ?? 0;
  const selectedHasRain = detailValue > 0 || detailProbability > 0;

  const WEATHER_CACHE_KEY = "jf-radar-cache-radar";
  const WEATHER_CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hora
  const refreshWeather = async (force = false) => {
    try {
      const cached = localStorage.getItem(WEATHER_CACHE_KEY);

      if (!force && cached) {
        const parsed = JSON.parse(cached);

        if (
          parsed.timestamp &&
          Date.now() - parsed.timestamp < WEATHER_CACHE_TTL &&
          parsed.data
        ) {
          setData(parsed.data);
          setLoading(false);
          return;
        }
      }

      setLoading(true);

      const response = await fetch("/api/weather/grid", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Falha ao carregar previsão.");
      }

      const weather = await response.json();

      setData(weather);

      localStorage.setItem(
        WEATHER_CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          data: weather,
        }),
      );
    } catch (error) {
      console.error("[Weather] Falha ao carregar previsão:", error);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const weatherRef = doc(
      clientDb,
      "weatherUpdates",
      "latest",
    );

    const unsubscribe = onSnapshot(
      weatherRef,
      () => {
        refreshWeather(true);
      },
      (error) => {
        console.error("[Weather] Listener:", error);
      },
    );

    return () => unsubscribe();
  }, []);

  return (
    <main className="radar-shell">
      <header className="radar-header">
        <div className="brand">
          <span className="brand-mark">
            <Image
              src="/icon.png"
              alt="Ícone"
              width={100}
              height={100}
            />
          </span>
          <div>
            <strong>JF RADAR</strong>
            <small>Juiz de Fora · MG</small>
          </div>
        </div>
        <div className="header-status">
          <span
            className={`status-dot ${
              data.status === "error" ? "offline" : ""
            }`}
          />

          {status}

          {!rainViewerLoading && rainViewerLatestFrame && (
            <>
              <span className="status-dot-red"></span>

              <span className="radar-live">
                <span className="radar-live-dot" />
                RADAR AO VIVO
              </span>

              <span className="radar-update">
                {format(rainViewerLatestFrame.time * 1000)}
              </span>
            </>
          )}

          <button
            className="icon-button"
            onClick={() => refresh(true)}
            aria-label="Atualizar dados"
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
          </button>
        </div>
      </header>
      <section className="map-stage">
        <WeatherMap
          tiles={data.tiles}
          selected={selected}
          rainViewerFrame={activeRadarFrame}
          onSelect={(name, tile) => {
            setSelected(name);
            setSelectedTile(tile);
            setSelectedRain(tile?.data ?? null);
            setForecastIndex(0);
            setPlaying(false);
          }}
        />
        <div className={`map-tools ${selected && forecastPlaybackLength > 0 ? "timeline-open" : ""}`}>
          <button
            onClick={() =>
              window.dispatchEvent(new CustomEvent("jf-map-center"))
            }
            aria-label="Centralizar Juiz de Fora"
            title="Centralizar Juiz de Fora"
          >
            <LocateFixed size={17} />
          </button>
        </div>
        <div className={`map-legend ${selected && forecastPlaybackLength > 0 ? "timeline-open" : ""}`}>
          <span>INTENSIDADE DA CHUVA</span>
          <i />
          <div>
            <b>Sem</b>
            <b>Fraca</b>
            <b>Moderada</b>
            <b>Forte</b>
          </div>
        </div>
        {data.status === "error" && (
          <div className="data-empty">
            <strong>DADOS METEOROLÓGICOS INDISPONÍVEIS</strong>
            <span>{data.message}</span>
          </div>
        )}
        {selected && (
          <div className="place-panel">
            <button
                onClick={() => {
                  setSelected(null);
                  setSelectedRain(null);
                  setSelectedTile(null);
                  setForecastIndex(0);
                  setPlaying(false);
                }}
              aria-label="Fechar"
            >
              ×
            </button>
            <span>BAIRRO SELECIONADO</span>
            <strong>{selected}</strong>
            <div className="rain-detail">
              <span>Intensidade: {intensity(detailValue)}</span>
              <span>
                Precipitação:{" "}
                {currentPoint
                  ? `${detailValue.toFixed(1)} mm/h`
                  : selectedRain
                    ? `${selectedRain.precipitation.toFixed(1)} mm/h`
                    : rain
                      ? `${rain.precipitation.toFixed(1)} mm/h`
                      : "indisponível"}
              </span>
              <span>Probabilidade: {detailProbability}%</span>
              <span>
                Atualizado: {rain ? format(rain.timestamp) : "indisponível"}
              </span>
            </div>
            <small>
              Geometria oficial: SISURB · Prefeitura de Juiz de Fora
            </small>
          </div>
        )}
        <div className="timeline">
          <div className="timeline-head">
            <div>
              <span>TEMPO REAL</span>
            </div>

            <strong>
              {activeRadarFrame
                ? "SATÉLITE OBSERVANDO"
                : rainViewerLoading
                  ? "CARREGANDO SATÉLITE"
                  : "SATÉLITE INDISPONÍVEL"}
            </strong>
          </div>

          {rainViewerFrames.length > 0 && (
            <div className="radar-controls">
              <button
                type="button"
                className="radar-nav-button"
                onClick={() => {
                  setRadarIndex((value) => Math.max(0, value - 1));
                }}
                disabled={radarIndex === 0}
                aria-label="Voltar 10 minutos"
              >
                ‹
              </button>

              <div className="radar-time">
                {activeRadarFrame
                  ? format(activeRadarFrame.time * 1000)
                  : "--:--"}
              </div>

              <button
                type="button"
                className={`radar-live-button ${
                  radarIndex === rainViewerFrames.length - 1 ? "active" : ""
                }`}
                onClick={() => {
                  setRadarIndex(rainViewerFrames.length - 1);
                }}
                aria-label="Ir para o radar ao vivo"
              >
                <span className="radar-live-indicator" />
                AO VIVO
              </button>

              <button
                type="button"
                className="radar-nav-button"
                onClick={() => {
                  setRadarIndex((value) =>
                    Math.min(rainViewerFrames.length - 1, value + 1),
                  );
                }}
                disabled={radarIndex === rainViewerFrames.length - 1}
                aria-label="Avançar 10 minutos"
              >
                ›
              </button>
            </div>
          )}

          {/* {selected && forecastPlaybackLength > 0 && (
            <div className="video-timeline">
              <div className="timeline-controls">
                <button
                  onClick={() => setPlaying((value) => !value)}
                  aria-label={playing ? "Pausar" : "Reproduzir"}
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>

                <span>{playing ? "REPRODUZINDO" : "PAUSADO"}</span>
              </div>

              <div className="timeline-track">
                <div
                  className="timeline-progress"
                  style={{
                    width: `${
                      forecastPlaybackLength > 1
                        ? (forecastIndex / (forecastPlaybackLength - 1)) * 100
                        : 0
                    }%`,
                  }}
                />

                <input
                  className="timeline-slider"
                  type="range"
                  min="0"
                  max={forecastPlaybackLength - 1}
                  value={forecastIndex}
                  onChange={(event) => {
                    setPlaying(false);
                    setForecastIndex(Number(event.target.value));
                  }}
                  aria-label={
                    selected
                      ? "Selecionar horário da previsão"
                      : "Selecionar horário do radar"
                  }
                />
              </div>

              <div className="timeline-scale">
                {selected
                  ? activeTimeline.map((point, index) => (
                      <span key={point.time}>
                        {index === 0 ? "AGORA" : format(point.time)}
                      </span>
                    ))
                  : rainViewerFrames.map((frame) => (
                      <span key={frame.time}>
                        {format(frame.time * 1000)}
                      </span>
                    ))}
              </div>
            </div>
          )} */}
          {selected && forecastPlaybackLength > 0 && (
            <div className="forecast-controls">
              <button
                type="button"
                className="forecast-nav-button"
                onClick={() => {
                  setForecastIndex((value) => Math.max(0, value - 1));
                }}
                disabled={forecastIndex === 0}
                aria-label="Voltar previsão"
              >
                ‹
              </button>

              <div className="forecast-time">
                {currentPoint
                  ? format(currentPoint.time)
                  : "--:--"}
              </div>

              <button
                type="button"
                className={`forecast-button ${
                  forecastIndex === 0 ? "active" : ""
                }`}
                onClick={() => {
                  setForecastIndex(0);
                  setPlaying(false);
                }}
                aria-label="Voltar para previsão atual"
              >
                PREVISÃO
              </button>

              <button
                type="button"
                className="forecast-nav-button"
                onClick={() => {
                  setForecastIndex((value) =>
                    Math.min(forecastPlaybackLength - 1, value + 1),
                  );
                }}
                disabled={forecastIndex === forecastPlaybackLength - 1}
                aria-label="Avançar previsão"
              >
                ›
              </button>
            </div>
          )}
        </div>

        <div className="dev-panel">
          <span>
            Desevolvido por: 
            <a href="https://www.linkedin.com/in/enrico-malta1/" target="_blank"> Enrico Malta</a>
          </span>
        </div>
      </section>
    </main>
  );
}
