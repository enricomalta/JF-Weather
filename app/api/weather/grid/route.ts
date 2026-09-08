import { NextResponse } from 'next/server'
import { createWeatherGrid } from '@/lib/weather/grid'
import { fetchWeatherGrid } from '@/lib/weather/tomorrow'

export async function GET() {
  const response = await fetchWeatherGrid(createWeatherGrid())
  return NextResponse.json(response, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' } })
}
