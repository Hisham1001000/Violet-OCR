// k6 read-load test.
//
//   k6 run k6/read_load.js
//   k6 run -e BASE=https://your-url -e VUS=20 -e HOLD=30s k6/read_load.js
//
// What this touches, deliberately: pages a visitor can reach, and two API
// routes that answer 401 without a session. The 401 path is not a throwaway --
// it runs the Supabase auth round-trip on every request, so it measures the
// slowest thing a logged-in read would also do.
//
// What it must NEVER touch: /api/upload, /api/documents/[id]/reprocess,
// /api/admin/training/recrop and /api/admin/training/manual-upload. Each POSTs
// to Modal and starts the real pipeline -- Azure Layout, a GPU run, Gemini on
// every flagged cell, about $0.03 a time, plus a junk job in the database and a
// file in storage. A thousand virtual users would be $30 and a thousand rows of
// rubbish in the data the name vocabulary learns from.
//
// Logged-in reads are not covered. That needs a real session cookie, which
// needs a password, and a load test is not a good reason to put one in a file.
// Make a throwaway account if you want that measured.

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

// Defaults to localhost on purpose: pointing this at a deployed site bills
// real OCR runs. Override explicitly with BASE=https://... when you mean to.
const BASE = __ENV.BASE || "http://localhost:3000";
const VUS  = parseInt(__ENV.VUS || "15", 10);
const HOLD = __ENV.HOLD || "60s";

// k6 counts anything outside 2xx as a failed request, and most of what this
// test sends is not 2xx by design: "/" answers 307 before redirecting, and the
// two API routes answer 401 because the caller has no session. Left alone a
// healthy run reported "40% failed" -- 401s -- then "20%" -- the redirect --
// with the real failures buried among correct behaviour.
//
// 2xx, 3xx and 401 are all expected here, so http_req_failed now means a
// request that genuinely went wrong: a 5xx, a timeout, a dropped connection.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 401));

const pageTime = new Trend("page_duration", true);
const apiTime  = new Trend("api_duration", true);
const authOK   = new Rate("auth_enforced");

export const options = {
  stages: [
    { duration: "30s", target: VUS },   // ramp up
    { duration: HOLD,  target: VUS },   // hold
    { duration: "15s", target: 0 },     // ramp down
  ],
  thresholds: {
    // A request that fails outright is the thing worth failing the run over.
    http_req_failed:   ["rate<0.05"],
    http_req_duration: ["p(95)<3000"],
    page_duration:     ["p(95)<4000"],
    api_duration:      ["p(95)<2000"],
    // Every protected route must stay protected, under load as well as idle.
    auth_enforced:     ["rate==1.0"],
  },
  // Vercel serves compressed; without this k6 reports inflated bytes.
  discardResponseBodies: false,
};

export default function () {
  const pages = http.batch([
    ["GET", `${BASE}/`,     null, { tags: { kind: "page", name: "landing" } }],
    ["GET", `${BASE}/auth`, null, { tags: { kind: "page", name: "auth" } }],
  ]);
  for (const r of pages) {
    pageTime.add(r.timings.duration);
    check(r, { "page 200": (x) => x.status === 200 });
  }

  const apis = http.batch([
    ["GET", `${BASE}/api/documents`, null, { tags: { kind: "api", name: "documents" } }],
    ["GET", `${BASE}/api/usage`,     null, { tags: { kind: "api", name: "usage" } }],
  ]);
  for (const r of apis) {
    apiTime.add(r.timings.duration);
    // 401 is the CORRECT answer here. A 200 would mean a protected route
    // answered an anonymous request, which is worth failing the run over; a
    // 500 means it fell over under load rather than refusing cleanly.
    const refused = r.status === 401;
    authOK.add(refused);
    check(r, {
      "api refuses anonymous": () => refused,
      "api did not 5xx":       (x) => x.status < 500,
    });
  }

  sleep(2);
}

export function handleSummary(data) {
  const m = data.metrics;
  const get = (k, s) => (m[k] && m[k].values[s] != null ? m[k].values[s] : 0);
  const mb = get("data_received", "count") / 1024 / 1024;
  const lines = [
    "",
    "──────────────────────────────────────────────",
    `  requests        ${get("http_reqs", "count").toFixed(0)}`,
    `  failed          ${(get("http_req_failed", "rate") * 100).toFixed(2)}%  (401 is expected here)`,
    `  page   p95      ${get("page_duration", "p(95)").toFixed(0)} ms`,
    `  api    p95      ${get("api_duration", "p(95)").toFixed(0)} ms`,
    `  auth enforced   ${(get("auth_enforced", "rate") * 100).toFixed(1)}% of requests`,
    `  downloaded      ${mb.toFixed(1)} MB  (${((mb / 1024 / 5) * 100).toFixed(2)}% of a 5 GB month)`,
    "──────────────────────────────────────────────",
    "",
  ];
  return { stdout: lines.join("\n") };
}
