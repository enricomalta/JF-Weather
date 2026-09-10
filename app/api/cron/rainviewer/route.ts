import { after } from "next/server";
import { refreshSecretIsValid } from "@/lib/weather/firebase-admin";
import { updateRainViewerHistory } from "@/lib/weather/rainviewer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: Request,
) {
  if (
    !refreshSecretIsValid(
      request,
    )
  ) {
    return new Response(
      "Não autorizado",
      {
        status: 401,
      },
    );
  }

  after(async () => {
    try {
      const result =
        await updateRainViewerHistory();

      console.log(
        "[RainViewer] Atualização concluída:",
        result,
      );
    } catch (error) {
      console.error(
        "[RainViewer] Erro na atualização:",
        error,
      );
    }
  });

  return Response.json(
    {
      ok: true,
      status: "started",
      message:
        "Atualização do histórico RainViewer iniciada em background.",
    },
    {
      status: 202,
      headers: {
        "Cache-Control":
          "no-store",
      },
    },
  );
}

export async function POST(
  request: Request,
) {
  return GET(request);
}