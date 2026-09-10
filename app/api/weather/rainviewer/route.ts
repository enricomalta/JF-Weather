import { NextResponse } from "next/server";
import { readRainViewerHistory } from "@/lib/weather/rainviewer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const history = await readRainViewerHistory();

    return NextResponse.json(history, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        frames: [],
        updatedAt: 0,
        error:
          error instanceof Error
            ? error.message
            : "Falha ao carregar histórico do RainViewer.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }
}