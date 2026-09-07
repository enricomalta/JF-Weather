import fs from "node:fs"
import path from "node:path"
import type { GeoFeatureCollection } from "./types"

export interface NeighborhoodPoint { id: string; name: string; lat: number; lon: number }

function coordinates(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return []
  if (typeof value[0] === "number") return [value as [number, number]]
  return value.flatMap(coordinates)
}

export function loadNeighborhoods(): NeighborhoodPoint[] {
  const file = path.join(process.cwd(), "public/geo/bairros-jf.geojson")
  const geo = JSON.parse(fs.readFileSync(file, "utf8")) as GeoFeatureCollection
  return geo.features.map((feature, index) => {
    const points = coordinates(feature.geometry?.coordinates)
    const [lon, lat] = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map((value) => value / Math.max(points.length, 1))
    const properties = feature.properties ?? {}
    const name = String(properties.name ?? properties.nome ?? properties.NOME ?? properties.bairro ?? `Bairro ${index + 1}`)
    return { id: String(feature.id ?? index), name, lat, lon }
  }).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
}
