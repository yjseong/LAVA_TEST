// The cron endpoint is public on Vercel and a refresh calls every upstream site, so it must refuse
// callers that do not present the secret (and refuse everyone when the secret is not configured there).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/refresh", () => ({
  refreshSources: vi.fn(async () => ({ status: "refreshed", durationMs: 1, errors: {} })),
}));

import { refreshSources } from "@/server/refresh";
import { GET } from "./route";

const call = (authorization?: string) =>
  GET(new Request("http://localhost/api/cron/refresh", { headers: authorization ? { authorization } : {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(refreshSources).mockClear();
});

describe("GET /api/cron/refresh", () => {
  it("on Vercel without CRON_SECRET: 401 and no refresh", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("CRON_SECRET", "");
    const res = await call("Bearer anything");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/CRON_SECRET is not set/);
    expect(refreshSources).not.toHaveBeenCalled();
  });

  it("with CRON_SECRET: wrong or missing credentials are 401", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect(refreshSources).not.toHaveBeenCalled();
  });

  it("with CRON_SECRET: the right bearer token runs the refresh", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(refreshSources).toHaveBeenCalledTimes(1);
  });

  it("locally (no VERCEL, no secret) it stays open for development", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CRON_SECRET", "");
    expect((await call()).status).toBe(200);
  });
});
