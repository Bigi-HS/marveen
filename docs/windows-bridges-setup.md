# WSL ↔ Windows Bridges — Setup Runbook (Dominik)

Step-by-step, Windows-side setup for the Big Ben content-pipeline bridges. The WSL-side
scripts and scaffolds (`scripts/windows-bridge.sh`, `scripts/windows-resolve-wrapper.py`,
`tools/lightroom-plugin/`, `tools/photoshop/`) are already built; this runbook is the
**human half** — the GUI toggles and the one elevated step the agent cannot do for you.

Each app section gives the exact click path (menu labels as they appear on screen), what you
should see at each step, the bridge step, and how to verify the bridge is live.

> **Card 7ebeea0d** — the four app-side GUI toggles are scheduled for Sunday 2026-06-14.

---

## 0. One-time concept (read once)

A Windows app that listens on `127.0.0.1:<port>` is **not** reachable from WSL by default.
WSL reaches it through a `netsh` **portproxy** on the WSL→Windows gateway IP. Two apps
(Photoshop Actions, Lightroom Classic) need **no port at all** — they bridge through files.

The only "live"/irreversible-ish step is applying a portproxy, which needs an **elevated**
(Administrator) PowerShell on Windows. That step is intentionally yours, not the agent's.
Everything the agent emits is reversible (`netsh ... delete` undoes a portproxy).

**Get the exact Admin-PowerShell block for any port — run this in WSL:**

```bash
scripts/windows-bridge.sh plan <port> --app <Name>
```

It prints a block like (idempotent — safe to re-run; `delete` clears any stale entry, the
firewall rule is only added if missing):

```
# --- WSL<->Windows bridge plan: REAPER (port 8080) ---
# Detected WSL->Windows gateway IP: 192.168.128.1
# Run the block below in an ELEVATED (Administrator) PowerShell on the WINDOWS host.
# It is idempotent: the netsh 'delete' clears any stale entry before re-adding.

netsh interface portproxy delete v4tov4 listenaddress=192.168.128.1 listenport=8080 2>$null
netsh interface portproxy add    v4tov4 listenaddress=192.168.128.1 listenport=8080 connectaddress=127.0.0.1 connectport=8080

if (-not (Get-NetFirewallRule -DisplayName "WSL-REAPER-8080" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "WSL-REAPER-8080" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Any
}

# Verify from WSL afterwards:  scripts/windows-bridge.sh verify 8080 --app REAPER
# --- end plan ---
```

Copy that whole block into an **Administrator** PowerShell on Windows and run it. Then verify
from WSL:

```bash
scripts/windows-bridge.sh verify <port> --app <Name>
```

Verify outcomes:
- `OK: <App> reachable` — bridge + app server both up. Done.
- `waiting: <App> not enabled yet` — the portproxy is up but the app server is not listening
  yet. Finish the app-side toggle (the app must actually be running with its server on).
- `unreachable: ... timed out` — portproxy/firewall missing, or the gateway IP changed after a
  reboot. Re-run `scripts/windows-bridge.sh gateway`; if the IP changed, re-`plan` + re-apply.

---

## 1. REAPER — Web Browser Interface (port 8080)

**App-side (REAPER), exact click path:**
1. Top menu: **Options → Preferences…** (or `Ctrl+P`). The Preferences window opens.
2. In the left tree, scroll to **Control/OSC/web** (under the *Audio* group near the bottom).
3. Click **Add** (right-hand side). An *"Add control surface"* (or *Control surface settings*)
   dialog opens.
4. **Control surface mode** dropdown → choose **Web browser interface**.
5. Set **Web interface port** = `8080`.
6. Optional: pick a **default web interface** layout (any of the listed `.html`), e.g.
   `Albeton_Live_ish.html` or the basic one. Not required for the bridge to answer.
7. Click **OK**, then **Apply** / **OK** on Preferences. REAPER now serves on
   `127.0.0.1:8080`. (You can confirm on the Windows box itself by opening
   `http://localhost:8080` in a Windows browser — you should see the REAPER web UI.)

**Bridge (Admin PowerShell on Windows):**
```bash
# in WSL, get the block:
scripts/windows-bridge.sh plan 8080 --app REAPER
```
Paste + run the emitted block in an **elevated** PowerShell.

**Verify (WSL):**
```bash
scripts/windows-bridge.sh verify 8080 --app REAPER
```
Expect `OK: REAPER reachable`. If you see `waiting`, REAPER isn't running or the web
interface toggle didn't stick — re-open Preferences and confirm the Web browser interface
row is present and enabled.

---

## 2. DaVinci Resolve — scripting wrapper (port 8081)

Resolve's scripting API is host-bound (`fusionscript.dll`, set via Windows env vars) and is
**not** importable from WSL directly, and the raw scripting socket has no hand-rollable wire
protocol. So we use a thin **Windows-side Python wrapper** (`scripts/windows-resolve-wrapper.py`)
that runs under Resolve's own Python and exposes a small HTTP surface; WSL reaches that wrapper
over a portproxy. (Architecture rationale lives in the bridge register, `store/windows-bridges.md`.)

**App-side (Resolve), exact click path:**
1. Top menu: **DaVinci Resolve → Preferences…** (macOS-style menu; on Windows it's the
   **DaVinci Resolve** menu at the top-left, or `Ctrl+,`).
2. Switch to the **System** tab (top of the Preferences window).
3. Left list → **General**.
4. Find **External scripting using** and set it to **Local**.
5. **Save**. Keep Resolve running.

**Windows-side wrapper (one-time, in a normal Windows shell — Command Prompt or PowerShell):**
3. Point Python at Resolve's scripting modules (adjust paths to your install):
   ```
   set RESOLVE_SCRIPT_API=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting
   set RESOLVE_SCRIPT_LIB=C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll
   set PYTHONPATH=%PYTHONPATH%;%RESOLVE_SCRIPT_API%\Modules
   ```
4. Run the wrapper (it binds `127.0.0.1:8081` only):
   ```
   python scripts\windows-resolve-wrapper.py
   ```
   Leave this window open while you want the bridge live. It logs `serving on 127.0.0.1:8081`.

**Bridge (Admin PowerShell):**
```bash
scripts/windows-bridge.sh plan 8081 --app Resolve
```
Paste + run elevated.

**Verify (WSL):**
```bash
scripts/windows-bridge.sh verify 8081 --app Resolve --path /health
```
Expect `OK` — the wrapper answers `/health` even before a project is open. `waiting` means the
wrapper isn't running (re-check the Windows shell) or Resolve's *External scripting = Local*
wasn't saved.

---

## 3. Photoshop — two paths

### 3a. Actions batch path (no bridge port — recommended to start)

No Developer Mode, no port. You record an Action once; Big Ben (from WSL) drops a config file
and launches Photoshop to run the batch.

**App-side (Photoshop), exact click path to record the Action:**
1. Top menu: **Window → Actions** (or `Alt+F9`). The Actions panel opens.
2. At the bottom of the Actions panel, click the **folder icon** ("Create new set"). Name the
   set `Genesis`. Click **OK**.
3. Click the **+ icon** ("Create new action"). Name it `WebExport`, make sure **Set** =
   `Genesis`, click **Record**. The round **Record** button at the panel bottom turns red.
4. Now perform your edit once (resize, filter, export settings — whatever the pipeline needs).
5. Click the **square Stop button** at the panel bottom to finish recording.

**Config + run (Big Ben does this from WSL; shown for your reference):**
1. Copy `tools/photoshop/photoshop-batch-config.sample.json` →
   `photoshop-batch-config.json` (beside `photoshop-batch-runner.jsx`), set `inputFolder`,
   `outputFolder`, and confirm `actionSet`=`Genesis`, `actionName`=`WebExport`.
2. Launch the batch:
   ```
   "C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe" -r tools\photoshop\photoshop-batch-runner.jsx
   ```
   The script runs headless (`displayDialogs = NO`), processes every image in `inputFolder`,
   and writes `photoshop-batch-done.json` beside the script when finished
   (`{"ok":true,"processed":N,"errors":0}`). WSL polls for that marker.

> Security note: the runner parses its config with **strict `JSON.parse`** and stops on a parse
> error — it never `eval()`s config content, so an automated/injected config cannot run
> arbitrary ExtendScript.

### 3b. UXP path (later, richer control — optional)
1. **Creative Cloud desktop → ⚙ Preferences → Enable "Developer Mode"** (or install the
   **UXP Developer Tool** from Creative Cloud). This toggle is yours; flag it when you want the
   UXP path and the agent will scaffold a UXP plugin + the WSL launch glue. Not needed for 3a.

---

## 4. Lightroom Classic — Lua plugin (no bridge port)

LrC plugins run in-process (Lua); the bridge is file-based (the action writes a file WSL reads).

**Deploy the plugin (exact click path):**
1. In Windows Explorer, copy the whole folder
   `tools/lightroom-plugin/genesis-bridge.lrplugin` into:
   `%USERPROFILE%\Documents\Adobe\Lightroom\Plugins\`
   (create the `Plugins` folder if it doesn't exist).
2. In Lightroom Classic, top menu: **File → Plug-in Manager…**. The Plug-in Manager opens.
3. Bottom-left → **Add**. Browse to and select the `genesis-bridge.lrplugin` folder, then
   **Add Plug-in** / **Select Folder**. It should appear in the left list as
   **Genesis Big Ben Bridge** with status *Installed and running*.
4. Click **Done**.

**Use / verify:**
1. Go to the **Library** module. Select one or more photos.
2. Top menu: **Library → Genesis: Export Selection Paths** (the menu item the plugin added).
3. It writes `~/Documents/genesis-bigben-selection.txt`. From WSL, confirm:
   ```bash
   cat /mnt/c/Users/<YourWindowsUser>/Documents/genesis-bigben-selection.txt
   ```
   You should see one selected photo's full path per line. That round-trip = the LrC bridge
   works.

---

## 5. Reboot note (all port bridges)

`netsh` portproxy entries and firewall rules **persist across reboot**. The WSL→Windows
**gateway IP can change** on reboot, though. If a previously-working `verify` starts timing
out after a reboot:
```bash
scripts/windows-bridge.sh gateway          # re-detect the current gateway IP
scripts/windows-bridge.sh plan 8080 --app REAPER   # re-emit with the new IP
scripts/windows-bridge.sh plan 8081 --app Resolve
```
Re-apply the emitted block(s) in an elevated PowerShell. The file-based bridges (Photoshop
Actions, Lightroom) are unaffected by reboots/IP changes.

---

## Quick reference

| App | Bridge | Port | App-side toggle | Verify |
| --- | --- | --- | --- | --- |
| REAPER | portproxy | 8080 | Preferences → Control/OSC/web → Add → Web browser interface | `verify 8080 --app REAPER` |
| DaVinci Resolve | portproxy → Python wrapper | 8081 | Preferences → System → General → External scripting = Local | `verify 8081 --app Resolve --path /health` |
| Photoshop (Actions) | file | — | Window → Actions → record set `Genesis`/`WebExport` | `photoshop-batch-done.json` marker |
| Lightroom Classic | file | — | File → Plug-in Manager → Add the `.lrplugin` | `genesis-bigben-selection.txt` |
