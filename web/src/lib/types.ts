// Shared contract between the server data layer (src/server, src/app/api) and the map UI (src/components).
// Field names deliberately follow the Python app (snake_case) so the two can be compared line by line.

/** One row of the volcano master list (src/data/volcanoes.json, built from volcano_master_all.xlsx). */
export interface Volcano {
  n: number; // Smithsonian GVP volcano number
  name: string;
  country: string;
  lat: number | null;
  lon: number | null;
  elev: number | null;
}

/** One VA advisory from BoM's 24-hour feed (carries the bulletins of every VAAC). */
export interface VaacRow {
  volcano: string;
  advisory: string;
  eruption: string;
  datetime: string; // issue time as written in the bulletin ("DTG": 20261104/0312Z)
  detail_url: string | null;
  source: string; // "Darwin VAAC", "Tokyo VAAC", ... (from the bulletin's "VAAC:" line)
  issuer: string;
  eruption_details: string;
  next_advisory: string;
  is_terminal: boolean; // "NO FURTHER ADVISORIES"
  area?: string;
}

/** One line of MIROVA's latest-alerts table. */
export interface MirovaRow {
  volcano: string;
  our_name: string | null;
  is_target: boolean;
  volcano_id: number;
  time: string;
  vrp_mw: string;
  sensor: string;
}

/** Current alert of one volcano from one source (volcano_alerts table in the Python app). */
export interface RegistryAlert {
  volcano_number: number;
  source: string; // JMA | PVMBG | PHIVOLCS | KVERT | VAAC
  alert_type: string; // volcano_level | aviation_code | vaa
  level: string;
  label: string;
  issued_at: string | null;
  observed_at: string | null;
  fetched_at: string;
  source_url: string | null;
  /** true when the source's last SUCCESSFUL refresh is older than 6 h (see STALE_AFTER) */
  stale: boolean;
}

export interface SourceStatus {
  source: string;
  last_success: string | null;
  last_attempt: string | null;
  status: "ok" | "error" | string;
  error: string | null;
}

/** GET /api/alerts - what the Dash app kept in the "alert-store" dcc.Store. */
export interface AlertPayload {
  registry: {
    by_number: Record<string, RegistryAlert[]>;
    sources: Record<string, SourceStatus>;
  };
  vaac_rows: VaacRow[];
  jma_raw: Record<string, number>; // JMA's own volcano name -> alert level
  jma_issued: Record<string, string>; // JMA's own volcano name -> "YYYY-MM-DD HH:MM UTC"
  mirova_rows: MirovaRow[];
  /** "YYYY-MM-DD HH:MM UTC" of the last successful source refresh; null if never */
  timestamp: string | null;
  /** digest of everything that matters for drawing; the UI skips re-rendering when it is unchanged */
  sig: string;
}

/** One alert-history entry (alert_events table). */
export interface AlertEvent {
  volcano_number: number;
  source: string;
  kind: string; // volcano_level | aviation_code | vaa | thermal
  label: string;
  level: string | null;
  event_time: string; // ISO 8601, UTC
  detail: string | null;
  url: string | null;
  first_seen: string;
}

/** GET /api/events?days=N[&number=M] */
export interface EventsResponse {
  events: AlertEvent[];
}
