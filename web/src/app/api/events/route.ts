import type { EventsResponse } from "@/lib/types";
import { getEventsWindow } from "@/server/events";

export const maxDuration = 60;

const intParam = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * GET /api/events?days=N[&number=M][&limit=L] -> EventsResponse.
 * days: 1-90 (default 7: the "Active alerts" list; 30 for one selected volcano). number: one volcano's history,
 * with the advisory-database rows merged in when VAA_DB_URL is configured.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const days = intParam(params.get("days")) ?? 7;
  const number = intParam(params.get("number"));
  const limit = intParam(params.get("limit")) ?? 2000;
  if (Number.isNaN(days) || days < 1 || days > 90) return bad("days must be an integer from 1 to 90");
  if (number !== undefined && (Number.isNaN(number) || number <= 0)) return bad("number must be a positive integer");
  if (Number.isNaN(limit) || limit < 1 || limit > 5000) return bad("limit must be an integer from 1 to 5000");
  try {
    const events = await getEventsWindow(days, { number, limit });
    const body: EventsResponse = { events };
    return Response.json(body, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (err) {
    console.error("[api/events]", err);
    return Response.json({ error: "history unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

const bad = (error: string) => Response.json({ error }, { status: 400, headers: { "Cache-Control": "no-store" } });
