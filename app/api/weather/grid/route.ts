import { NextResponse } from 'next/server'
import { createWeatherGrid } from '@/lib/weather/grid'

export const dynamic = 'force-dynamic'
export const revalidate = 0
import { fetchWeatherGrid } from '@/lib/weather/tomorrow'

export async function GET() {
  const response = await fetchWeatherGrid(createWeatherGrid())
  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
