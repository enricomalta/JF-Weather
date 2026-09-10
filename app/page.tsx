"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Crosshair, LocateFixed, Pause, Play, RefreshCw } from "lucide-react";
import Image from "next/image";
import type { RainViewerFrame } from "@/lib/weather/rainviewer";


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
  message: "Configure TOMORROW_API_KEY para iniciar o monitoramento.",
};
const CACHE_KEY = "jf-weather-grid-cache-v4";
const CACHE_TTL = 5 * 60 * 1000;
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
  const [timelineIndex, setTimelineIndex] = useState(0);
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

    fetch("/api/weather/rainviewer", {
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Falha ao carregar RainViewer.");
        }

        return response.json();
      })
      .then((result) => {
        setRainViewerFrames(
          Array.isArray(result.frames) ? result.frames : [],
        );
      })
      .catch(() => {
        setRainViewerFrames([]);
      })
      .finally(() => {
        setRainViewerLoading(false);
      });
  }, []);
  const forecastTimeline = selectedTile?.timeline?.length
    ? selectedTile.timeline
    : data.timeline;

  const activeTimeline = selected
    ? forecastTimeline
    : [];

  const activeRadarFrame =
    !selected && rainViewerFrames.length > 0
      ? rainViewerFrames[timelineIndex] ?? rainViewerFrames[0]
      : null;

  const playbackLength = selected
    ? activeTimeline.length
    : rainViewerFrames.length;

  useEffect(() => {
    if (!playing || playbackLength < 2) return;

    const timer = window.setInterval(
      () =>
        setTimelineIndex((value) =>
          value >= playbackLength - 1 ? 0 : value + 1,
        ),
      900,
    );

    return () => window.clearInterval(timer);
  }, [playing, playbackLength]);
  const rain = selectedRain ?? data.tiles.find((tile) => tile.data)?.data ?? null;
  const currentPoint: TimelinePoint | null = activeTimeline[timelineIndex] ?? null;
  const status = loading
    ? "ATUALIZANDO…"
    : data.status === "error"
      ? "SERVIÇO INDISPONÍVEL"
      : `ATUALIZADO ${format(data.updateTimestamp)}`;
  const detailValue = currentPoint?.precipitation ?? rain?.precipitation ?? 0;
  const detailProbability = currentPoint?.probability ?? rain?.precipitationProbability ?? 0;
  const selectedHasRain = detailValue > 0 || detailProbability > 0;
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
            className={`status-dot ${data.status === "error" ? "offline" : ""}`}
          />
          {status}
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
            setTimelineIndex(0);
          }}
        />
        <div className="map-tools">
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
        <div className="map-legend">
          <span>INTENSIDADE DA CHUVA</span>
          <i />
          <div>
            <b>Sem chuva</b>
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
                setTimelineIndex(0);
              }}
              aria-label="Fechar"
            >
              ×
            </button>
            <span>BAIRRO SELECIONADO</span>
            <strong>{selected}</strong>
            <div className="rain-detail">
              {/* <b>
                {selected
                  ? selectedHasRain
                    ? "Chuva prevista"
                    : "Sem chuva"
                  : rain
                    ? rain.precipitation > 0 ||
                      rain.precipitationProbability > 0
                      ? "Chuva prevista"
                      : "Sem chuva"
                    : "Chuva sem observação"}
              </b> */}
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
              <span>{selected ? "PREVISÃO" : "RADAR"}</span>
                <b>
                  {selected
                    ? currentPoint
                      ? format(currentPoint.time)
                      : "Sem previsão disponível"
                    : activeRadarFrame
                      ? format(activeRadarFrame.time * 1000)
                      : "Sem radar disponível"}
                </b>
            </div>
            <strong>
              {selected
                ? currentPoint
                  ? `${currentPoint.precipitation.toFixed(1)} mm/h · ${currentPoint.probability}%`
                  : "Aguardando dados"
                : activeRadarFrame
                  ? "RADAR OBSERVADO"
                  : rainViewerLoading
                    ? "CARREGANDO RADAR"
                    : "RADAR INDISPONÍVEL"}
            </strong>
          </div>
          {activeTimeline.length > 0 && (
            <div className="video-timeline">
              <div className="timeline-controls">
                <button
                  onClick={() => setPlaying((value) => !value)}
                  aria-label={
                    playing ? "Pausar previsão" : "Reproduzir previsão"
                  }
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <span>{playing ? "REPRODUZINDO" : "PAUSADO"}</span>
              </div>
              <div className="timeline-track">
                <div
                  className="timeline-progress"
                  style={{
                    width: `${activeTimeline.length > 1 ? (timelineIndex / (activeTimeline.length - 1)) * 100 : 0}%`,
                  }}
                />
                <input
                  className="timeline-slider"
                  type="range"
                  min="0"
                  max={activeTimeline.length - 1}
                  value={timelineIndex}
                  onChange={(event) => {
                    setPlaying(false);
                    setTimelineIndex(Number(event.target.value));
                  }}
                  aria-label="Selecionar horário da previsão"
                />
              </div>
              <div className="timeline-scale">
                {activeTimeline.map((point, index) => (
                  <span key={point.time}>
                    {index === 0 ? "AGORA" : format(point.time)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {playbackLength > 0 && (
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
                      playbackLength > 1
                        ? (timelineIndex / (playbackLength - 1)) * 100
                        : 0
                    }%`,
                  }}
                />

                <input
                  className="timeline-slider"
                  type="range"
                  min="0"
                  max={playbackLength - 1}
                  value={timelineIndex}
                  onChange={(event) => {
                    setPlaying(false);
                    setTimelineIndex(Number(event.target.value));
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
          )}
        </div>
      </section>
    </main>
  );
}
