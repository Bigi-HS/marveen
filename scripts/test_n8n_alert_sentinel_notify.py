#!/usr/bin/env python3
"""Tests for scripts/n8n-alert-sentinel-notify.py (card OPS/efb226fe).

Dependency-free (no pytest): run with `python3 scripts/test_n8n_alert_sentinel_notify.py`.
Exercises the pure helpers (build_message, read_token) directly and the main()
orchestration with run_sentinel + send monkeypatched, so nothing hits the
network. Covers: findings -> exactly one send carrying the finding; ok:true /
empty findings / malformed JSON -> silent; findings-but-no-token -> no send;
sentinel failure -> no send; token-file chain falls through an empty file to a
populated one; and that main() ALWAYS returns 0.
"""
import importlib.util
import os
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MODPATH = os.path.join(HERE, "n8n-alert-sentinel-notify.py")

spec = importlib.util.spec_from_file_location("n8n_notify", MODPATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

PASS = 0
FAIL = 0


def check(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS  %s" % label)
    else:
        FAIL += 1
        print("FAIL  %s" % label)


FINDINGS_JSON = (
    '{"sentinel":"n8n-alert-sentinel","ok":false,"workflows_scanned":15,'
    '"findings":[{"class":"ALERT_SPAM","severity":"high","workflow":"wf-noa-003r",'
    '"detail":"7 verified alert sends in last 24h","fix":"audit the alert condition"}]}'
)
CLEAN_JSON = '{"sentinel":"n8n-alert-sentinel","ok":true,"findings":[]}'


# ---- build_message (pure) ----
msg = mod.build_message(FINDINGS_JSON)
check(msg is not None and "wf-noa-003r" in msg and "1 finding" in msg,
      "(a) build_message: findings -> message with workflow + count")
check(mod.build_message(CLEAN_JSON) is None, "(b) build_message: ok:true -> None")
check(mod.build_message('{"ok":false,"findings":[]}') is None,
      "(c) build_message: ok:false but empty findings -> None")
check(mod.build_message("not json {") is None, "(d) build_message: malformed -> None")


# ---- read_token (chain) ----
with tempfile.TemporaryDirectory() as tmp:
    empty = os.path.join(tmp, "empty.env")
    populated = os.path.join(tmp, "tok.env")
    open(empty, "w").close()
    with open(populated, "w") as fh:
        fh.write("SOMETHING=1\nTELEGRAM_BOT_TOKEN=FAKETOKEN123\n")

    mod.TOKEN_FILES = "%s:%s" % (empty, populated)
    check(mod.read_token() == "FAKETOKEN123",
          "(e) read_token: chain falls through empty -> populated")

    mod.TOKEN_FILES = "%s:%s" % (empty, os.path.join(tmp, "missing.env"))
    check(mod.read_token() is None, "(f) read_token: no token in chain -> None")


# ---- main() orchestration (run_sentinel + send monkeypatched) ----
def install(sentinel_output, token):
    sent = []

    def fake_run_sentinel():
        return sentinel_output

    def fake_send(tok, text):
        sent.append((tok, text))

    mod.run_sentinel = fake_run_sentinel
    mod.send = fake_send
    mod.read_token = (lambda: token)
    return sent


# findings + token -> exactly one send carrying the finding; returns 0
sent = install(FINDINGS_JSON, "TOK1")
rc = mod.main()
check(rc == 0, "(g) main: findings -> returns 0")
check(len(sent) == 1 and sent[0][0] == "TOK1" and "wf-noa-003r" in sent[0][1],
      "(h) main: findings -> one send with right token + message")

# ok:true -> no send
sent = install(CLEAN_JSON, "TOK1")
rc = mod.main()
check(rc == 0 and len(sent) == 0, "(i) main: ok:true -> no send, returns 0")

# findings but no token -> no send
sent = install(FINDINGS_JSON, None)
rc = mod.main()
check(rc == 0 and len(sent) == 0, "(j) main: findings + no token -> no send, returns 0")

# sentinel failure (run_sentinel returns None) -> no send
sent = install(None, "TOK1")
rc = mod.main()
check(rc == 0 and len(sent) == 0, "(k) main: sentinel failure -> no send, returns 0")

# malformed sentinel output -> no send
sent = install("garbage {", "TOK1")
rc = mod.main()
check(rc == 0 and len(sent) == 0, "(l) main: malformed output -> no send, returns 0")


# ---- send failure must NOT leak the token to stderr (chad advisory, PR#851) ----
import contextlib  # noqa: E402 -- test-local, after the module is loaded
import io  # noqa: E402

SECRET = "123456:AA-SECRET-BOT-TOKEN"


def raising_send(tok, text):
    # Mimic an HTTPError/URLError whose text embeds the request URL (token in path).
    exc = RuntimeError("HTTP Error 401 for https://api.telegram.org/bot%s/sendMessage" % SECRET)
    exc.code = 401
    raise exc


mod.run_sentinel = lambda: FINDINGS_JSON
mod.read_token = lambda: SECRET
mod.send = raising_send
err = io.StringIO()
with contextlib.redirect_stderr(err):
    rc = mod.main()
captured = err.getvalue()
check(rc == 0, "(m) main: send failure -> still returns 0")
check(SECRET not in captured,
      "(n) main: send-failure stderr does NOT leak the bot token")
check("RuntimeError" in captured and "401" in captured,
      "(o) main: send-failure stderr still reports exception type + HTTP status")


print("")
print("%d passed, %d failed" % (PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
