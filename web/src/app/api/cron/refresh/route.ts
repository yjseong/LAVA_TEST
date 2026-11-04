import { refreshSources } from "@/server/refresh";

export const maxDuration = 60;

/**
 * GET /api/cron/refresh - for a Vercel Cron (Pro plan allows every minute; Hobby only daily, and the page refreshes
 * the data by itself when visited anyway). Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set
 * in the project; the route insists on it (and, on Vercel, refuses to run at all when the variable is missing).
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // On Vercel the endpoint is public, and a refresh calls every upstream site: without a secret anyone could
  // hammer them through it. So a deployment must set CRON_SECRET to use the cron (locally it stays open).
  const authorized = secret
    ? request.headers.get("authorization") === `Bearer ${secret}`
    : !process.env.VERCEL;
  if (!authorized) {
    return Response.json(
      { error: secret ? "unauthorized" : "CRON_SECRET is not set" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const result = await refreshSources();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[api/cron/refresh]", err);
    return Response.json({ error: "refresh failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
