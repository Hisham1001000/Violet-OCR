# SOP: Add a New Webhook

## Purpose
Register a new Modal webhook that responds to HTTP POST requests by running a Claude-orchestrated directive. Each webhook maps to exactly one directive and has a scoped tool allowlist.

## Prerequisites
- Modal CLI installed and authenticated (`modal token new`)
- Repo cloned, `.env` populated with all required secrets
- Modal secrets created: `modal secret create claude-orchestrator-secrets ANTHROPIC_API_KEY=... ...`
- `execution/modal_webhook.py` deployed at least once

## Inputs
- What the webhook should do (user description)
- A short, URL-safe slug (hyphenated, e.g. `daily-report`)
- Which tools it needs: `send_email`, `read_sheet`, `update_sheet`

## Steps

### 1. Create the directive file
Create `directives/{slug}.md` describing:
- **Goal**: What this webhook accomplishes
- **Trigger**: What event fires it and what the inbound payload looks like
- **Tools available**: Which tools Claude may use (must match step 2 allowlist)
- **Expected output**: What should happen (email sent, sheet updated, Slack message, etc.)
- **Edge cases**: What to do if data is missing, an API fails, or payload is unexpected

### 2. Register in webhooks.json
Add an entry to `execution/webhooks.json` under the `"webhooks"` key:

```json
"{slug}": {
  "directive": "{slug}.md",
  "description": "One-line description of what this webhook does",
  "tools": ["send_email"]
}
```

Only list tools the webhook actually needs — least-privilege enforcement.
Available tools: `send_email`, `read_sheet`, `update_sheet`

### 3. Redeploy Modal
```bash
modal deploy execution/modal_webhook.py
```

The new slug is live immediately after deploy completes.

### 4. Test the endpoint
```bash
curl -X POST \
  "https://<your-modal-workspace>--directive.modal.run?slug={slug}" \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

Check Slack for real-time activity logs.

### 5. Verify in list-webhooks
```bash
curl https://<your-modal-workspace>--list-webhooks.modal.run
```

Your new slug should appear in the response.

## Outputs
- New directive file at `directives/{slug}.md`
- Updated `execution/webhooks.json`
- Redeployed Modal app
- Slack confirmation of activity on trigger

## Edge Cases
- **Slug already exists**: Update the existing entry and directive rather than creating a duplicate
- **Tool not in registry**: Only `send_email`, `read_sheet`, `update_sheet` are available. Adding new tools requires updating `modal_webhook.py` and `execution/tools/`
- **Deploy fails**: Run `modal logs violet-pipeline` to diagnose. Common causes: missing Modal secret key, Python syntax error
- **Directive missing at runtime**: The `/directive` endpoint returns HTTP 500. Ensure the file is committed and the app is redeployed
- **Claude returns unexpected output**: Update the directive with clearer instructions and more explicit edge case handling

## Notes
- Directives are living documents. Update them as you learn constraints, API limits, or timing expectations
- All webhook calls, tool invocations, and errors stream to Slack in real-time
- Modal cold starts take ~3-5 seconds; warm invocations are near-instant
- The `/directive` endpoint timeout is 300 seconds — sufficient for multi-step Claude + tool sequences
