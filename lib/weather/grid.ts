export const JUIZ_DE_FORA = { lat: -21.7642, lon: -43.3503 }

export function createWeatherGrid(rows = 5, columns = 7) {
  const latStep = 0.42 / Math.max(rows - 1, 1)
  const lonStep = 0.56 / Math.max(columns - 1, 1)
  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    return { lat: -21.97 + row * latStep, lon: -43.63 + column * lonStep }
  })
}
