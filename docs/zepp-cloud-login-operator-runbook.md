# Zepp cloud-sleep — hands-off login operator runbook

Hands-off accurate net-sleep pull. No MITM capture, no token-burn: the puller logs in with the
account email+password (huami-token v0.8.0 flow, AES-encrypted credential exchange) and mints a
**fresh app_token every run**. The Boss (operator) runs it server-side; no credential or token
value is ever printed, logged, or echoed.

## 1. Credentials (one-time, operator)

Write the Zepp account email+password into the password creds file (0600):

```
/home/domin/marveen/store/zepp/.creds.json
{ "email": "<zepp account email>", "password": "<zepp account password>" }
```

- File is already populated (NoA loaded it from the Boss-provided source, 0600).
- The legacy `~/.zepp-creds.json` (captured apptoken + host) is **no longer required** for this
  path; it is only a fallback if the password file is absent.
- The data region defaults to **de2** (Boss's account). To override, add `"region":"us2"` (or
  `"host":"api-mifit-...zepp.com"`) to the password file.

## 2. Run the pull (operator, server-side)

From the repo root (or worktree), for a specific night:

```
npx tsx src/web/zepp/cloud-sleep-cli.ts 2026-09-09
```

Omit the date to pull "yesterday" (Europe/Budapest).

## 3. Expected output (safe fields only)

```json
{"date":"2026-09-09","status":"ok","host":"api-mifit-de2.zepp.com","auth":"password",
 "netSleepMin":464,"stages":{"deep":142,"light":322,"rem":0,"awake":145},"score":78,
 "startAt":"...","endAt":"..."}
```

- `auth:"password"` confirms the fresh-login path was used.
- **Verify:** `netSleepMin` for 2026-09-09 must be **464** (dp142 + lt322 + rem0 = 7h44m), matching
  the Boss phone gold value. That is the parse-verify acceptance gate before the PR is unheld.

## 4. Failure statuses (stderr JSON, non-zero exit)

| status          | meaning                                             | action                                  |
|-----------------|-----------------------------------------------------|-----------------------------------------|
| `no_creds`      | neither creds file usable                           | re-check store/zepp/.creds.json         |
| `auth_fail`     | login rejected (bad email/password, or 303/200 miss)| verify credentials; check region        |
| `no_data`       | login OK but no sleep row for that date             | try an adjacent date; confirm sync       |
| `endpoint_error`| 5xx / endpoint drift                                | transient; retry; else endpoint changed  |

## 5. Security notes

- email/password enter only the AES-encrypted request body; app_token/login_token stay in process
  memory and the request header. None are printed or logged (verified by Chad value-exposure audit
  on the captured path; same discipline holds here).
- The operator runs the CLI; agents never execute it with real credentials.
- Login endpoints are us2 (region-agnostic auth handshake); the sleep pull targets the de2 data host.
