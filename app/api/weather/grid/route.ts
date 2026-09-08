import { NextResponse } from "next/server"
import { readWeather } from "@/lib/weather/tomorrow"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    return NextResponse.json(await readWeather(), { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    return NextResponse.json({ tiles: [], timeline: [], timestamp: Date.now(), updateTimestamp: 0, nextUpdate: 0, status: "error", message: error instanceof Error ? error.message : "Firebase indisponível" }, { status: 503 })
  }
}
