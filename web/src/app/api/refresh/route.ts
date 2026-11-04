import { manualRefresh } from "@/server/payload";

export const maxDuration = 60;

/**
 * POST /api/refresh - the "Refresh" button. Refreshes the sources now (JMA's cache shortens to 60 s), waits up to
 * ~10 s, and answers with the AlertPayload (same shape as GET /api/alerts). A slow source keeps working after the
 * response. Within 15 s of the previous forced refresh it only returns the current data (header X-Refresh: throttled).
 */
export async function POST() {
  try {
    const { payload, refreshed } = await manualRefresh();
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store", "X-Refresh": refreshed ? "started" : "throttled" },
    });
  } catch (err) {
    console.error("[api/refresh]", err);
    return Response.json({ error: "refresh failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
