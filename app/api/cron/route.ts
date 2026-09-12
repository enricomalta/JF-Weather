import { after } from "next/server";
import { refreshSecretIsValid } from "@/lib/weather/firebase-admin";
import { runWeatherUpdate } from "@/lib/weather/tomorrow";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  if (!refreshSecretIsValid(request)) {
    return new Response("Não autorizado", {
      status: 401,
    });
  }

  after(async () => {
    try {
      await Promise.all([
        runWeatherUpdate(),
      ]);
    } catch (error) {
      console.error(
        "Erro na execução assíncrona do worker meteorológico:",
        error,
      );
    }
  });

  return Response.json(
    {
      ok: true,
      status: "started",
      message: "Atualização meteorológica iniciada em background.",
    },
    {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function POST(request: Request) {
  return GET(request);
}
