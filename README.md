# GapScout: setup (Phase 2b/3)

## 0. Deploy on Render (recommended path)
1. Push this folder to a GitHub repo.
2. Render dashboard -> New -> Blueprint -> pick the repo (uses `render.yaml`). Keep the **Starter** plan: persistent disks need a paid instance, and on the free tier the SQLite database is wiped on every deploy/restart (and the service sleeps after 15 min idle).
3. When prompted, set `SERPAPI_KEY`, `NOMINATIM_UA` (your email), and leave `AP_WEBHOOK_URL` blank for now.
4. After deploy, open Environment and copy `DASHBOARD_KEY` (your dashboard login) and `AP_SHARED_SECRET` (goes in the Activepieces `x-secret` header).
5. Build the 4 flows (section 3), put Flow 1's webhook URL in `AP_WEBHOOK_URL`, redeploy.
6. Open `https://<your-service>.onrender.com`, enter the access key when asked, run a search with limit 20.

## 1. Other hosts (must be public HTTPS; Activepieces cloud cannot reach localhost)
Any host that runs Node 22 or Docker **with a persistent disk** works (Render, Railway, Fly.io, a VPS).
Mount a volume at `/data`, set the env vars from `.env.example`, start with `npm start`.
Check: `GET https://<your-service>.onrender.com/api/searches/x` returns `{"error":"not found"}` (404 JSON means the API is up).

## 2. Credentials
- **SerpApi**: key from your SerpApi dashboard -> `SERPAPI_KEY`. Each Maps page and each verification query is 1 search credit. Check your plan's monthly quota first.
- **AP_SHARED_SECRET**: make one up (32+ random chars). Used only between backend and Activepieces.
- **Nominatim** needs no key, only `NOMINATIM_UA` with a contact address.

## 3. Activepieces flows (build in the UI; I could not inspect your instance, so no importable JSON is provided)
Use the data selector to insert values rather than typing expressions; exact paths can differ slightly by version.
All HTTP steps use piece **HTTP -> Send HTTP request**, method POST, header `x-secret: <AP_SHARED_SECRET>`, `content-type: application/json`.

**Flow 1 - Intake**: Trigger **Webhook -> Catch Webhook** (copy its URL to `AP_WEBHOOK_URL`; do NOT use /sync).
1. HTTP POST to Flow 2's webhook URL with body = the trigger body (`searchId`, `pages`).
(The backend already validated input and created the job.)

**Flow 2 - Discovery**: Trigger Catch Webhook.
1. **Loop on Items** over `trigger.body.pages`.
2. Inside: HTTP POST `https://<your-service>.onrender.com/api/internal/discover` body `{"searchId": <searchId>, "page": <loop item>}`. Pages after the last result return `skipped` and cost nothing.
3. After loop: HTTP POST Flow 3's webhook with `{"searchId": ...}`.

**Flow 3 - Verification**: Trigger Catch Webhook.
1. HTTP GET `https://<your-service>.onrender.com/api/internal/searches/<searchId>/pending` returns `{items:[{businessId,name}]}`.
2. **Loop on Items** over `items`. Inside: HTTP POST `/api/internal/verify-run` body `{"businessId": <item.businessId>}`. In the step settings, enable retry on failure if offered.
3. After loop: HTTP POST Flow 4's webhook with `{"searchId": ...}`.

**Flow 4 - Publication**: Trigger Catch Webhook.
1. HTTP POST `/api/internal/finalize` body `{"searchId": ...}` returns `completed` / `partial` / `failed`.
2. Optional: email/Slack notification with that status.

Deviation from the brief: **no separate Enrichment flow**. Maps already returns phone, address, coordinates, thumbnail and listing website; social profiles are found during verification. Add a flow later if you add a source that needs it.

## 4. First live test (keep it small: `limit: 20` = 1 Maps credit + ~3 per business)
POST `/api/searches` with `{"category":"real estate agencies","city":"Owerri","region":"Imo","country":"Nigeria","limit":20}`, then poll `GET /api/searches/<id>`.

## 5. Known limits / unverified
- Not yet run against live SerpApi, Nominatim or Activepieces; tests use hand-built fixtures matching the documented field names.
- Businesses are labelled with the searched city, not parsed from each address.
- Google Maps thumbnails: reuse rights are not verified; shown with attribution only.
- A long verification loop may hit Activepieces cloud execution-time limits; test with 20 first.
- Maps `website` is only a hint; classification still needs search evidence. Search-snippet matching can miss a real site (so "no website found" is capped at medium confidence).
