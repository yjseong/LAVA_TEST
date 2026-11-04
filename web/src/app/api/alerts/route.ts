import { getAlertPayload } from "@/server/payload";

export const maxDuration = 60; // a cold start waits for the first source refresh

/**
 * GET /api/alerts -> AlertPayload (what the Dash app kept in the "alert-store").
 * Served from the stored snapshot; a snapshot older than 60 s also starts a refresh behind the response.
 */
export async function GET() {
  try {
    const payload = await getAlertPayload();
    return Response.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[api/alerts]", err);
    return Response.json({ error: "alert data unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
