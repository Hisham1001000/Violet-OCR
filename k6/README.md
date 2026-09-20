# Load tests

Two [k6](https://k6.io) scripts. Both default to `http://localhost:3000` and
only hit production if you say so with `-e BASE=https://…` — which you should
think about first, because these pages are backed by a real database and a
pipeline that costs money per run.

| Script | Question it answers |
|---|---|
| `read_load.js` | Is it up, and how does it respond under steady read traffic? |
| `journeys.js` | What does it feel like when a signed-in browser, a signed-out visitor and a bot all arrive at once — and where does it stop? |

## Running

Locally, against a dev server:

```bash
k6 run k6/read_load.js
k6 run -e VUS=20 -e HOLD=30s k6/read_load.js
k6 run k6/journeys.js                       # mix mode
k6 run -e MODE=capacity k6/journeys.js      # ramp until a threshold breaks
```

On Modal, which is how these are normally run — no local k6 install, and the
load arrives from outside your own network:

```bash
modal run execution/modal_k6.py --script journeys.js
modal run execution/modal_k6.py --script journeys.js --mode capacity
```

## Two things to know before reading the numbers

**Capacity mode ramps arrival rate, not virtual users.** A virtual user waits
for its own response, so as the site slows it sends *less* — and hides the
slowdown you are looking for. Arrivals keep coming regardless, which is what
real users do.

**These pages are client-rendered shells.** `/dashboard` answers 200 to anyone
and checks the session in the browser. So a 200 here does not mean a user got
their data; it means the server did the work behind the shell. Read the timings,
not the status codes.

Neither script uploads a document. Nothing here triggers a real OCR run, and
nothing here should be pointed at production casually.
