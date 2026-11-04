// What a collector / normalizer hands to the registry.
export interface AlertInput {
  volcano_number: number | string | null;
  alert_type: string; // volcano_level | aviation_code | vaa
  level: string;
  label?: string;
  issued_at?: string | null;
  observed_at?: string | null;
  source_url?: string | null;
  /** source-specific evidence; only `raw.eruption` is read (as the alert-history detail) */
  raw?: Record<string, unknown>;
}

/** An official-source collector (PVMBG / KVERT / PHIVOLCS): returns the alerts it could match, or throws. */
export type OfficialCollector = () => Promise<AlertInput[]>;
