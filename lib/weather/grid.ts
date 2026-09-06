export const JUIZ_DE_FORA = { lat: -21.7642, lon: -43.3503 }

export function createWeatherGrid(rows = 9, columns = 11) {
  const latSpan = 0.24
  const lonSpan = 0.32
  const latStep = latSpan / Math.max(rows - 1, 1)
  const lonStep = lonSpan / Math.max(columns - 1, 1)
  const minLat = JUIZ_DE_FORA.lat - latSpan / 2
  const minLon = JUIZ_DE_FORA.lon - lonSpan / 2

  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    return {
      lat: minLat + row * latStep,
      lon: minLon + column * lonStep,
    }
  })
}
