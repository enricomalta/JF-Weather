"use client";

import { useEffect, useState } from "react";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { FeatureCollection } from "geojson";
import type { GeoFeatureCollection, WeatherTile } from "@/lib/weather/types";
import "leaflet/dist/leaflet.css";
import type { RainViewerFrame } from "@/lib/weather/rainviewer";


const CENTER: [number, number] = [-21.76, -43.35];
const color = (value: number) =>
  value <= 0
    ? "#163d47"
    : value < 2.5
      ? "#39c6d8"
      : value < 7.6
        ? "#f0c84b"
        : "#ef6657";
const cloudOpacity = (value: number) =>
  value <= 0 ? 0 : value < 2.5 ? 0.92 : value < 7.6 ? 0.95 : 0.98;

function ZoomEvents({ onZoom }: { onZoom: (zoom: number) => void }) {
  useMapEvents({ zoomend: (event) => onZoom(event.target.getZoom()) });
  return null;
}

function Actions() {
  const map = useMap();
  useEffect(() => {
    const reset = () => map.setView(CENTER, 11, { animate: false });
    window.addEventListener("jf-map-center", reset);
    return () => {
      window.removeEventListener("jf-map-center", reset);
    };
  }, [map]);
  return null;
}

export function WeatherMap({
  tiles,
  selected,
  rainViewerFrame,
  onSelect,
}: {
  tiles: WeatherTile[];
  selected: string | null;
  rainViewerFrame: RainViewerFrame | null;
  onSelect: (name: string, tile: WeatherTile | null) => void;
}) {
  const [geo, setGeo] = useState<GeoFeatureCollection | null>(null);
  const [zoom, setZoom] = useState(11);
  useEffect(() => {
    fetch("/geo/bairros-jf.geojson")
      .then((r) => r.json())
      .then(setGeo)
      .catch(() => setGeo(null));
  }, []);
  const collection = geo as unknown as FeatureCollection;
  const nearest = (feature: any) => {
    const pairs: Array<[number, number]> = [];
    const collectPairs = (value: unknown) => {
      if (!Array.isArray(value)) return;
      if (
        value.length >= 2 &&
        typeof value[0] === "number" &&
        typeof value[1] === "number"
      ) {
        pairs.push([value[0], value[1]]);
        return;
      }
      value.forEach(collectPairs);
    };
    collectPairs(feature.geometry?.coordinates);
    const longitude = pairs.length
      ? pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
      : CENTER[1];
    const latitude = pairs.length
      ? pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
      : CENTER[0];

    return (
      tiles
        .filter((tile) => tile.data)
        .reduce<WeatherTile | null>((closest, tile) => {
          if (!closest) return tile;
          const distance = Math.hypot(tile.lon - longitude, tile.lat - latitude);
          const closestDistance = Math.hypot(
            closest.lon - longitude,
            closest.lat - latitude,
          );
          return distance < closestDistance ? tile : closest;
        }, null)
    );
  };
  return (
    <div className="map-canvas leaflet-map">
      <MapContainer
        center={CENTER}
        zoom={11}
        minZoom={10}
        maxZoom={19}
        zoomControl={false}
        className="leaflet-root"
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {!selected && rainViewerFrame && (
          <TileLayer
            key={rainViewerFrame.time}
            url={`${rainViewerFrame.url}/256/{z}/{x}/{y}/2/1_1.png`}
            opacity={0.75}
            maxNativeZoom={7}
          />
        )}
        <Actions />
        <ZoomEvents onZoom={setZoom} />
        {geo && (
          <GeoJSON
            data={collection}
            style={(feature) => {
              const name = String(
                feature?.properties?.nome ?? feature?.properties?.NOME ?? "",
              );
              return {
                color: name === selected ? "#ffffff" : "#79aeb4",
                weight: name === selected ? 3 : 1.2,
                fillColor: name === selected ? "#39c6d8" : "#12333a",
                fillOpacity: name === selected ? 0.42 : 0.18,
              };
            }}
            onEachFeature={(feature, layer) => {
              const name = String(
                feature.properties?.nome ??
                  feature.properties?.NOME ??
                  "Bairro",
              );
              layer.on({
                click: () => onSelect(name, nearest(feature)),
                mouseover: () =>
                  layer
                    .bindTooltip(name, {
                      sticky: true,
                      className: "bairro-tooltip",
                    })
                    .openTooltip(),
                mouseout: () => layer.closeTooltip(),
              });
            }}
          />
        )}
        {tiles
          .filter((tile) => tile.data && (tile.data.precipitation ?? 0) > 0)
          .map((tile) => {
            const value = tile.data?.precipitation ?? 0;
            const tone = color(value);
            return (
              <CircleMarker
                key={`${tile.lat}-${tile.lon}`}
                center={[tile.lat, tile.lon]}
                radius={Math.min(38, 20 + value * 3)}
                pathOptions={{
                  color: tone,
                  fillColor: tone,
                  fillOpacity: cloudOpacity(value),
                  weight: 3,
                  opacity: 1,
                  bubblingMouseEvents: false,
                }}
              />
            );
          })}
        {zoom >= 15 && <></>}
      </MapContainer>
      <div className="map-attribution">
        Mapa base © OpenStreetMap · Limites SISURB · Prefeitura de Juiz de Fora
      </div>
      {!geo && (
        <div className="map-loading">
          Carregando limites oficiais dos bairros…
        </div>
      )}
    </div>
  );
}

export { CENTER };
