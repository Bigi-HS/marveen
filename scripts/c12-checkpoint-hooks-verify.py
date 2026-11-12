#!/usr/bin/env python3
"""c12-equivalent pre-flip gate for the 4 memory-continuity checkpoint hooks
(card 2493cafc, S3).

WHY THIS EXISTS (not a vitest unit test): the chameleon `smoke` only proves
"launch + 60s survive + ping", so it CANNOT exercise a lifecycle-EVENT hook --
morphing the buster sandbox never ENDS / COMPACTS its session, so a SessionEnd /
PreCompact / SessionStart hook never fires there. Per the c12-chameleon-test
skill, the valid c12-equivalent for such hooks is a DIRECT-INVOCATION harness
over the REAL hook scripts: drive each with controlled stdin payloads and assert
the return code + the branch-correct side effect against the live dashboard,
then clean up. This file is that harness, committed as a REPEATABLE gate so it
is re-run (not re-derived) before the co-activation flip.

HOW TO RUN (manual / operator, needs the live dashboard on localhost:3420):
    python3 scripts/c12-checkpoint-hooks-verify.py
Exit 0 = ALL GREEN. It is NOT auto-run by CI (it needs the running server and
writes/clears disposable buster checkpoint state); the committed unit coverage
is src/__tests__/agent-checkpoint*.test.ts + the hook unit tests.

Hooks under test (the 4 wired checkpoint entries):
  - checkpoint-write.py precompact  (PreCompact)
  - checkpoint-write.py sessionend  (SessionEnd)
  - checkpoint-write.py tick        (UserPromptSubmit)
  - checkpoint-replay.py            (SessionStart)

Branch coverage per hook:
  POSITIVE: sub-agent cwd (agents/buster) -> resolves agent -> live side effect.
  NEGATIVE (false-positive guards): main cwd (root) -> agent=None -> exit0 NO
    side effect; empty cwd -> exit0; malformed stdin -> exit0.
  INERT-STATE: a normal `startup` replay with the co-activation flag OFF (the
    real production state, store/session-end-marker.enabled absent) must NOT
    replay -> proves the engine stays dormant until the operator flag-flip. This
    is the de-risk the co-activation decision rests on.
  DEDUP CONTRACT: a replay whose injection carries a recent-turns window stamps
    the one-boot ledger-suppression marker (store/agent-checkpoints/
    <agent>.ledger-suppressed) so the overlapping ledger window is injected once.

Uses buster (the disposable sandbox agent); clears all buster checkpoint /
marker state at start and end. Never writes to a live (non-sandbox) agent.
"""
import subprocess
import json
import os
import urllib.request
import urllib.error

# Project root = parent of scripts/ (portable; no hardcoded path).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WRITE = os.path.join(ROOT, "scripts", "hooks", "checkpoint-write.py")
REPLAY = os.path.join(ROOT, "scripts", "hooks", "checkpoint-replay.py")
AGENT = "buster"
CP_DIR = os.path.join(ROOT, "store", "agent-checkpoints")
SUPPRESS_MARKER = os.path.join(CP_DIR, "%s.ledger-suppressed" % AGENT)
FLAG = os.path.join(ROOT, "store", "session-end-marker.enabled")
API = "http://localhost:3420/api"
TOK = open(os.path.join(ROOT, "store", ".dashboard-token")).read().strip()

results = []


def record(name, ok, detail):
    results.append((name, ok, detail))


def run(hook, args, payload):
    p = subprocess.run(
        ["python3", hook] + args,
        input=json.dumps(payload) if payload is not None else "not-json{",
        capture_output=True, text=True, timeout=20,
    )
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def _req(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOK)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return {"_http": e.code}
    except Exception as e:
        return {"_err": str(e)}


def get_checkpoint():
    return _req("GET", "/agent-checkpoint/%s" % AGENT)


def delete_checkpoint():
    _req("DELETE", "/agent-checkpoint/%s" % AGENT)


def clean_buster():
    delete_checkpoint()
    for p in (SUPPRESS_MARKER,):
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


# The co-activation flag MUST be off for the inert-state assertion to be honest.
FLAG_PRESENT_AT_START = os.path.exists(FLAG)

clean_buster()

# ---------------------------------------------------------------------------
# 1. checkpoint-write POSITIVE -- each trigger stamps a record with its tag.
# ---------------------------------------------------------------------------
for trigger in ("precompact", "sessionend", "tick"):
    clean_buster()
    rc, out, err = run(WRITE, [trigger], {"cwd": os.path.join(ROOT, "agents", AGENT)})
    rec = get_checkpoint()
    focus = (rec or {}).get("focus")
    ok = (rc == 0 and focus == "checkpoint:%s" % trigger and not (rec or {}).get("consumed"))
    record("write[%s] sub-agent -> stamps checkpoint, exit0" % trigger, ok,
           "rc=%s focus=%r" % (rc, focus))

# ---------------------------------------------------------------------------
# 2. checkpoint-write NEGATIVE -- main / empty / malformed => exit0, NO write.
#    NOTE: clearCheckpoint only unlinks the FS record; resolveCheckpoint falls
#    back to the throttled noa.db mirror (G2 crash backstop), so a DELETE does
#    not guarantee an empty GET. We therefore seed a KNOWN sentinel focus and
#    assert the hook did NOT overwrite it (a real write would set checkpoint:tick).
# ---------------------------------------------------------------------------
def seed_sentinel(tag):
    clean_buster()
    _req("POST", "/agent-checkpoint/%s" % AGENT, {"focus": tag})
    return tag


SENT = seed_sentinel("neg-sentinel")
rc, out, err = run(WRITE, ["tick"], {"cwd": ROOT})
focus = (get_checkpoint() or {}).get("focus")
record("write main-session (root cwd) -> exit0, NO overwrite", (rc == 0 and focus == SENT),
       "rc=%s focus=%r (expect sentinel)" % (rc, focus))

seed_sentinel("neg-sentinel")
rc, out, err = run(WRITE, ["tick"], {"source": "x"})  # no cwd key
focus = (get_checkpoint() or {}).get("focus")
record("write empty cwd -> exit0, NO overwrite", (rc == 0 and focus == SENT),
       "rc=%s focus=%r (expect sentinel)" % (rc, focus))

rc, out, err = run(WRITE, ["tick"], None)  # malformed stdin
record("write malformed stdin -> exit0 no crash", (rc == 0), "rc=%s" % rc)

# ---------------------------------------------------------------------------
# 3. checkpoint-replay POSITIVE (compact source, NOT flag-gated) + DEDUP.
#    Seed a record carrying a recent-turns window via the live API (setup, not
#    the thing under test), then drive the REAL replay hook.
# ---------------------------------------------------------------------------
clean_buster()
seed = _req("POST", "/agent-checkpoint/%s" % AGENT, {
    "focus": "c12-seed",
    "lastTurns": [{"in": "c12 harness seed turn", "out": "ack, continuing"}],
    "summary": "c12 replay seed",
})
seeded = bool((seed or {}).get("ok"))

rc, out, err = run(REPLAY, [], {"cwd": os.path.join(ROOT, "agents", AGENT), "source": "compact"})
injected = ""
try:
    parsed = json.loads(out) if out else {}
    injected = parsed.get("hookSpecificOutput", {}).get("additionalContext", "")
except Exception:
    injected = ""
suppress_stamped = os.path.exists(SUPPRESS_MARKER)
record("replay[compact] sub-agent -> prints injection, exit0", (rc == 0 and bool(injected)),
       "rc=%s inject_len=%d seeded=%s" % (rc, len(injected), seeded))
record("replay DEDUP: lastTurns injection stamps ledger-suppress marker", suppress_stamped,
       "marker=%s" % suppress_stamped)

# second replay -> record now consumed -> no injection (idempotent consume)
rc2, out2, err2 = run(REPLAY, [], {"cwd": os.path.join(ROOT, "agents", AGENT), "source": "compact"})
record("replay again -> consumed, no re-inject (idempotent)", (rc2 == 0 and not out2.strip()),
       "rc=%s out_empty=%s" % (rc2, not out2.strip()))

# ---------------------------------------------------------------------------
# 4. checkpoint-replay NEGATIVE + INERT-STATE.
# ---------------------------------------------------------------------------
# main cwd -> agent None -> exit0 no print (even with a fresh seeded record)
clean_buster()
_req("POST", "/agent-checkpoint/%s" % AGENT, {"focus": "c12-seed2",
     "lastTurns": [{"in": "seed2", "out": "ack2"}]})
rc, out, err = run(REPLAY, [], {"cwd": ROOT, "source": "compact"})
record("replay main-session (root cwd) -> exit0, no inject", (rc == 0 and not out.strip()),
       "rc=%s out_empty=%s" % (rc, not out.strip()))

rc, out, err = run(REPLAY, [], {"source": "compact"})  # empty cwd
record("replay empty cwd -> exit0, no inject", (rc == 0 and not out.strip()),
       "rc=%s out_empty=%s" % (rc, not out.strip()))

# INERT-STATE: a normal `startup` replay with the co-activation flag OFF must NOT
# replay (crash-gate dormant until the operator flag-flip). Record still present.
if not FLAG_PRESENT_AT_START:
    rc, out, err = run(REPLAY, [], {"cwd": os.path.join(ROOT, "agents", AGENT), "source": "startup"})
    inert_ok = (rc == 0 and not out.strip())
    record("INERT: startup replay, flag OFF -> dormant, no inject", inert_ok,
           "rc=%s out_empty=%s flag_off=True" % (rc, not out.strip()))
else:
    record("INERT: startup replay, flag OFF (SKIPPED: flag present)", True,
           "flag file exists -> cannot assert inert state")

# ---------------------------------------------------------------------------
# cleanup -- leave zero buster test state behind.
# ---------------------------------------------------------------------------
clean_buster()
residual_marker = os.path.exists(SUPPRESS_MARKER)
residual_cp = bool(get_checkpoint() and "focus" in (get_checkpoint() or {}))
clean = (not residual_cp and not residual_marker)

print("=== c12-equivalent verify: 4 checkpoint hooks (card 2493cafc S3) ===")
allok = True
for name, ok, detail in results:
    allok = allok and ok
    print(("PASS" if ok else "FAIL"), name, "|", detail)
print("cleanup: buster checkpoint+marker cleared:", clean)
print("flag state at start (co-activation): %s" % ("PRESENT" if FLAG_PRESENT_AT_START else "ABSENT (inert, production)"))
print("VERDICT:", "ALL GREEN" if (allok and clean) else "FAILURE")

raise SystemExit(0 if (allok and clean) else 1)
