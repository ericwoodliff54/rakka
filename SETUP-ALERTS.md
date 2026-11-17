# Background recall alerts: setup

Do this once after you deploy the new `rakka-worker.js`. Nothing here contains a secret, so this file is safe to keep in the repo.

## 1. Turn on the schedule (Cloudflare Cron Trigger)
1. Cloudflare dashboard, Workers & Pages, open `rakka-edge`.
2. Settings, Triggers, Cron Triggers, Add.
3. Enter `*/10 * * * *` (every 10 minutes) and save.

Each run fetches the FDA and USDA feeds and does almost nothing when no recall is new. When a recall is new, the worker checks every device that turned alerts on against just the new recalls, 2,500 devices per run, and picks up where it left off on the next run. In a test with 6,000 simulated devices, a full pass took three runs of about half a second each, and a run with nothing new cost 6 storage calls.

## Cloudflare plan
Use **Workers Paid** (you have it). A scheduled run then gets 30 seconds of computing time and 10,000 storage and network calls, and KV reads and writes are not capped per day. At thousands of users the extra usage cost should be small: the plan includes millions of requests and KV operations each month, and extras are billed per million. Check Cloudflare's current pricing page when you plan the launch.

## 2. Nothing else is needed for testing
Without push, alerts still work inside the app. Every time RAKKA opens (and when it comes back to the foreground, at most every 5 minutes) it sends the watchlist, then shows any recall the server found. This is also the safety net once push exists.

To try it: use a Plus device, open Settings, Background Recall Alerts, Turn On. The status line shows how many items are watched and when the last check ran.

## 3. Push notifications (when the store app exists)
Push uses Firebase Cloud Messaging, which covers Android and iPhone.
1. Create a Firebase project, add the Android and iOS apps (Apple needs its push key uploaded in Firebase).
2. Firebase console, Project settings, Service accounts, Generate new private key.
3. In the Worker, Settings, Variables and Secrets, add a **Secret** named `FCM_SERVICE_ACCOUNT` and paste the whole JSON file.
4. In the Capacitor app, when the push token arrives, call `window.RakkaPush.setToken(token, 'ios' or 'android')`.

Notifications carry only generic text. The details are shown inside RAKKA.

## What the server stores
Per device that turned alerts on: names, brands and barcodes of the watchlist, a random device ID, a random alert key, the Plus token, an optional push token, and the queue of alerts not yet seen. It is erased when the person turns alerts off, when Plus lapses, with Delete my data, or after 120 days without the app opening. See `privacy.html`.
