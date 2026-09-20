// k6 journey + capacity test.
//
//   modal run execution/modal_k6.py --script journeys.js
//   modal run execution/modal_k6.py --script journeys.js --mode capacity
//
// Two modes.
//
// MIX (default) reproduces the shape of real traffic: several journeys running
// at once, each arriving at its own rate, the way a mixed audience actually
// hits a site. read_load.js answers "is it up"; this answers "what does it feel
// like when a browser, a signed-out visitor and a bot are all here at once".
//
// CAPACITY answers the other question -- where does it stop. Arrival rate is
// ramped until a threshold breaks. Arrival rate, not VU count, because a
// virtual user waits for its own response: as the site slows, VUs send LESS and
// hide the very slowdown being looked for. Arrivals keep coming regardless,
// which is what real users do.
//
// Pages here are client-rendered shells: /dashboard answers 200 to anyone and
// checks the session in the browser. So this measures the server work behind a
// first paint, which is real, but it is NOT a logged-in read. Those need a
// session cookie and a password, and this file has no business holding one.
//
// NEVER add /api/upload, /reprocess, recrop, manual-upload or billing/checkout.
// Each starts the real pipeline: Azure, a GPU run, Gemini, about $0.03 and a
// junk row every time. execution/modal_k6.py refuses to run a script naming
// them, which is a backstop, not permission to try.
//
// Deliberately absent: the reprocess rate limiter. Testing it is only safe
// while the limiter is actually live -- it rejects before any paid work. If the
// Upstash variables are not set in Vercel it is not live, every request reaches
// Modal, and the "safe" test bills for each one.

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

// Defaults to localhost on purpose: pointing this at a deployed site bills
// real OCR runs. Override explicitly with BASE=https://... when you mean to.
const BASE = __ENV.BASE || "http://localhost:3000";
const MODE = (__ENV.MODE || "mix").toLowerCase();
const RATE = parseInt(__ENV.RATE || "10", 10);   // iterations/sec in mix mode
const PEAK = parseInt(__ENV.PEAK || "120", 10);  // iterations/sec to ramp to

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 401));

const journey = new Trend("journey_duration", true);
const authOK  = new Rate("auth_enforced");
const served  = new Counter("pages_served");

// One place to change the shape of a run. Each journey is a named sequence of
// pages, in the order somebody would actually walk them.
const JOURNEYS = {
  browse:   ["/", "/pricing", "/policy"],          // someone deciding whether to sign up
  signin:   ["/", "/auth"],                        // someone coming back
  returning:["/dashboard", "/documents"],          // the shell a signed-in user loads first
};

const mixScenarios = {
  browse: {
    executor: "constant-arrival-rate",
    rate: RATE, timeUnit: "1s", duration: "1m",
    preAllocatedVUs: 20, maxVUs: 100,
    exec: "browse", tags: { journey: "browse" },
  },
  signin: {
    executor: "constant-arrival-rate",
    rate: Math.max(1, Math.round(RATE / 2)), timeUnit: "1s", duration: "1m",
    preAllocatedVUs: 10, maxVUs: 50,
    exec: "signin", tags: { journey: "signin" },
  },
  returning: {
    executor: "constant-arrival-rate",
    rate: Math.max(1, Math.round(RATE / 2)), timeUnit: "1s", duration: "1m",
    preAllocatedVUs: 10, maxVUs: 50,
    exec: "returning", tags: { journey: "returning" },
  },
  api: {
    executor: "constant-arrival-rate",
    rate: Math.max(1, Math.round(RATE / 2)), timeUnit: "1s", duration: "1m",
    preAllocatedVUs: 10, maxVUs: 50,
    exec: "api", tags: { journey: "api" },
  },
};

const capacityScenarios = {
  ramp: {
    executor: "ramping-arrival-rate",
    startRate: 5, timeUnit: "1s",
    preAllocatedVUs: 50, maxVUs: 600,
    stages: [
      { target: Math.round(PEAK * 0.25), duration: "30s" },
      { target: Math.round(PEAK * 0.50), duration: "30s" },
      { target: Math.round(PEAK * 0.75), duration: "30s" },
      { target: PEAK,                    duration: "30s" },
      { target: PEAK,                    duration: "30s" },
    ],
    exec: "browse", tags: { journey: "capacity" },
  },
};

export const options = {
  scenarios: MODE === "capacity" ? capacityScenarios : mixScenarios,
  thresholds: {
    http_req_failed: ["rate<0.05"],
    // Abort a capacity run once it is clearly over the edge, rather than
    // spending minutes hammering something already broken.
    http_req_duration: [
      { threshold: "p(95)<3000", abortOnFail: MODE === "capacity", delayAbortEval: "20s" },
    ],
    auth_enforced: ["rate==1.0"],
  },
  discardResponseBodies: false,
};

function walk(name) {
  const t0 = Date.now();
  group(name, () => {
    for (const path of JOURNEYS[name]) {
      const r = http.get(`${BASE}${path}`, { tags: { page: path } });
      served.add(1);
      check(r, { [`${path} ok`]: (x) => x.status === 200 });
      sleep(0.3);            // a person reads before clicking
    }
  });
  journey.add(Date.now() - t0);
}

export function browse()    { walk("browse"); }
export function signin()    { walk("signin"); }
export function returning() { walk("returning"); }

export function api() {
  const rs = http.batch([
    ["GET", `${BASE}/api/documents`, null, { tags: { page: "/api/documents" } }],
    ["GET", `${BASE}/api/usage`,     null, { tags: { page: "/api/usage" } }],
  ]);
  for (const r of rs) {
    const refused = r.status === 401;
    authOK.add(refused);
    check(r, {
      "api refuses anonymous": () => refused,
      "api did not 5xx": (x) => x.status < 500,
    });
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (k, s) => (m[k] && m[k].values[s] != null ? m[k].values[s] : 0);
  const mb = v("data_received", "count") / 1024 / 1024;
  const reqs = v("http_reqs", "count");
  const secs = data.state ? data.state.testRunDurationMs / 1000 : 0;

  const out = [
    "",
    `  MODE ${MODE.toUpperCase()}   ${BASE}`,
    "  ───────────────────────────────────────────────",
    `  requests          ${reqs.toFixed(0)}   (${(reqs / (secs || 1)).toFixed(1)}/sec sustained)`,
    `  pages served      ${v("pages_served", "count").toFixed(0)}`,
    `  genuinely failed  ${(v("http_req_failed", "rate") * 100).toFixed(2)}%`,
    `  auth enforced     ${(v("auth_enforced", "rate") * 100).toFixed(1)}%`,
    "",
    `  one page   p50 ${v("http_req_duration", "p(50)").toFixed(0)}ms   ` +
      `p95 ${v("http_req_duration", "p(95)").toFixed(0)}ms   ` +
      `max ${v("http_req_duration", "max").toFixed(0)}ms`,
    `  a journey  p95 ${v("journey_duration", "p(95)").toFixed(0)}ms   ` +
      `(includes 300ms of reading between clicks)`,
    "",
    `  downloaded        ${mb.toFixed(1)} MB  (${((mb / 1024 / 5) * 100).toFixed(2)}% of a 5 GB month)`,
    "  ───────────────────────────────────────────────",
    "",
  ];
  return { stdout: out.join("\n") };
}
