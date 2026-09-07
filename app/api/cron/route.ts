import { refreshWeather } from "@/lib/weather/tomorrow"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET(request: Request) {
  return refreshWeather(request)
}

export async function POST(request: Request) {
  return refreshWeather(request)
}
