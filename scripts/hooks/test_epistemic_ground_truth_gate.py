#!/usr/bin/env python3
"""Tests for epistemic-ground-truth-gate.py (card 23adafe9).

Run: python3 scripts/hooks/test_epistemic_ground_truth_gate.py
All assertions pass == green.

Design principles:
- Pure-python, hermetic, no live Telegram / network.
- Uses LEDGER_DB_PATH test seam (ledger_lib.py:98) to avoid touching prod noa.db.
- Drives module-level functions directly for unit cases.
- Drives stdin->exit end-to-end via subprocess for integration cases.
- Assertions are DANGEROUS-DIRECTION first (ungrounded claim DOES warn).
"""
import importlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import textwrap

HOOK_DIR = os.path.dirname(os.path.abspath(__file__))
HOOK_PATH = os.path.join(HOOK_DIR, "epistemic-ground-truth-gate.py")

sys.path.insert(0, HOOK_DIR)

# Force re-import in case of stale module in cache
for mod in list(sys.modules.keys()):
    if "epistemic" in mod or mod == "ledger_lib":
        del sys.modules[mod]

import ledger_lib  # noqa: E402

# Import the hook module's predicates directly
import importlib.util
spec = importlib.util.spec_from_file_location("epig", HOOK_PATH)
epig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epig)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_transcript(turns):
    """Build a JSONL transcript string from a list of dicts (turn descriptors).

    Each dict:
      {"role": "user"|"assistant",
       "text": str,                          # optional plain text content
       "tool_uses": [{"name": str, "input": dict}]  # optional tool_use blocks
      }
    """
    lines = []
    for t in turns:
        role = t.get("role", "user")
        if role == "user":
            content = t.get("text", "ping")
            entry = {"type": "user", "message": {"content": content}}
        else:
            blocks = []
            if "text" in t:
                blocks.append({"type": "text", "text": t["text"]})
            for tu in t.get("tool_uses", []):
                blocks.append({
                    "type": "tool_use",
                    "name": tu["name"],
                    "input": tu.get("input", {}),
                })
            entry = {"type": "assistant", "message": {"content": blocks}}
        lines.append(json.dumps(entry))
    return "\n".join(lines)


def run_hook(payload_dict, db_path=None, transcript_content=None):
    """Run the hook as a subprocess. Returns (returncode, stderr_text).

    If transcript_content is supplied, writes it to a temp file and injects
    'transcript_path' into the payload.
    If db_path is supplied, sets LEDGER_DB_PATH env var.
    """
    env = os.environ.copy()
    with tempfile.TemporaryDirectory() as td:
        if transcript_content is not None:
            tp = os.path.join(td, "transcript.jsonl")
            with open(tp, "w", encoding="utf-8") as f:
                f.write(transcript_content)
            payload_dict = dict(payload_dict, transcript_path=tp)

        if db_path is not None:
            env["LEDGER_DB_PATH"] = db_path

        payload_json = json.dumps(payload_dict)
        result = subprocess.run(
            [sys.executable, HOOK_PATH],
            input=payload_json,
            capture_output=True,
            text=True,
            env=env,
        )
    return result.returncode, result.stderr


GUARDED_TOOL = "mcp__plugin_telegram_telegram__reply"


def make_reply_payload(text):
    return {
        "tool_name": GUARDED_TOOL,
        "tool_input": {"text": text},
        "cwd": "/home/domin/marveen",
    }


# ---------------------------------------------------------------------------
# --- UNIT TESTS (driving module predicates directly) ----------------------
# ---------------------------------------------------------------------------

def test_find_claim_trigger_basic():
    """A contradiction marker + number in a sentence -> trigger."""
    text = "Valójában ez 42 nap volt, nem 7."
    trigger = epig.find_claim_trigger(text)
    assert trigger is not None, "Expected a trigger for 'Valójában ... 42'"
    assert "al" in trigger.lower() or "j" in trigger.lower()
    print("PASS test_find_claim_trigger_basic")


def test_find_claim_trigger_nem_igaz():
    """'nem igaz' + number fires."""
    text = "Nem igaz, az összeg 1500 forint volt."
    trigger = epig.find_claim_trigger(text)
    assert trigger is not None, "Expected trigger for 'nem igaz ... 1500'"
    print("PASS test_find_claim_trigger_nem_igaz")


def test_find_claim_trigger_tevedsz():
    """'tévedsz' + date fires."""
    text = "Tévedsz, a határidő 2026-01-15 volt."
    trigger = epig.find_claim_trigger(text)
    assert trigger is not None, "Expected trigger for 'tévedsz ... 2026'"
    print("PASS test_find_claim_trigger_tevedsz")


def test_find_claim_trigger_no_number():
    """Contradiction marker without a number -> no trigger."""
    text = "Valójában nem így van, csak szóban egyeztünk."
    trigger = epig.find_claim_trigger(text)
    assert trigger is None, "Should NOT trigger without a number: '{}'".format(text)
    print("PASS test_find_claim_trigger_no_number")


def test_find_claim_trigger_question_skipped():
    """A question sentence with a marker+number is skipped."""
    text = "Valójában 42 volt? Vagy más?"
    trigger = epig.find_claim_trigger(text)
    assert trigger is None, "Question sentence should not trigger"
    print("PASS test_find_claim_trigger_question_skipped")


def test_find_claim_trigger_quoted_skipped():
    """A marker+number inside a quoted sentence is skipped."""
    text = '"Valójában 42 nap volt." Ez volt az eredeti kijelentés.'
    trigger = epig.find_claim_trigger(text)
    # The second sentence has no marker, so no trigger
    assert trigger is None, "Quoted sentence should not trigger"
    print("PASS test_find_claim_trigger_quoted_skipped")


def test_is_hedged_true():
    """'nem tudom' -> hedge."""
    assert epig.is_hedged("Nem tudom pontosan, de valami 42."), "Expected hedge"
    print("PASS test_is_hedged_true")


def test_is_hedged_false():
    """No hedge in a plain contradicting reply."""
    assert not epig.is_hedged("Valójában ez 42 volt, nem 7."), "Should NOT be hedged"
    print("PASS test_is_hedged_false")


def test_has_ground_truth_read_tool(tmp_path):
    """Read tool_use in current turn -> has ground truth."""
    transcript = make_transcript([
        {"role": "user", "text": "Mikor volt a meetingünk?"},
        {"role": "assistant", "tool_uses": [{"name": "Read", "input": {"file_path": "/tmp/x.txt"}}]},
    ])
    tp = str(tmp_path / "t.jsonl")
    with open(tp, "w") as f:
        f.write(transcript)
    result = epig.has_ground_truth_in_current_turn(tp)
    assert result is True, "Read tool_use should count as ground-truth"
    print("PASS test_has_ground_truth_read_tool")


def test_has_ground_truth_grep_tool(tmp_path):
    """Grep tool_use in current turn -> has ground truth."""
    transcript = make_transcript([
        {"role": "user", "text": "Keress valamit."},
        {"role": "assistant", "tool_uses": [{"name": "Grep", "input": {"pattern": "foo"}}]},
    ])
    tp = str(tmp_path / "t.jsonl")
    with open(tp, "w") as f:
        f.write(transcript)
    result = epig.has_ground_truth_in_current_turn(tp)
    assert result is True, "Grep tool_use should count as ground-truth"
    print("PASS test_has_ground_truth_grep_tool")


def test_has_ground_truth_bash_db(tmp_path):
    """Bash with noa.db reference in current turn -> has ground truth."""
    transcript = make_transcript([
        {"role": "user", "text": "Mit mond az adatbázis?"},
        {"role": "assistant", "tool_uses": [
            {"name": "Bash", "input": {"command": "sqlite3 store/noa.db 'SELECT count(*) FROM kanban_cards'"}}
        ]},
    ])
    tp = str(tmp_path / "t.jsonl")
    with open(tp, "w") as f:
        f.write(transcript)
    result = epig.has_ground_truth_in_current_turn(tp)
    assert result is True, "Bash with noa.db should count as ground-truth"
    print("PASS test_has_ground_truth_bash_db")


def test_has_ground_truth_no_verify(tmp_path):
    """No verify tool in current turn -> no ground truth."""
    transcript = make_transcript([
        {"role": "user", "text": "Mi volt a szám?"},
        {"role": "assistant", "text": "Jól emlékszem, 42 volt."},
    ])
    tp = str(tmp_path / "t.jsonl")
    with open(tp, "w") as f:
        f.write(transcript)
    result = epig.has_ground_truth_in_current_turn(tp)
    assert result is False, "No verify tool -> no ground truth"
    print("PASS test_has_ground_truth_no_verify")


def test_has_ground_truth_before_last_user_does_not_count(tmp_path):
    """A verify tool-call BEFORE the last user message does NOT count."""
    transcript = make_transcript([
        {"role": "user", "text": "Első kérdés"},
        {"role": "assistant", "tool_uses": [{"name": "Read", "input": {"file_path": "/tmp/x"}}]},
        {"role": "user", "text": "Második kérdés"},  # <-- last real user line
        {"role": "assistant", "text": "Valasz anelkul verify"},
    ])
    tp = str(tmp_path / "t.jsonl")
    with open(tp, "w") as f:
        f.write(transcript)
    result = epig.has_ground_truth_in_current_turn(tp)
    assert result is False, "Verify before last user message should NOT count"
    print("PASS test_has_ground_truth_before_last_user_does_not_count")


# ---------------------------------------------------------------------------
# --- INTEGRATION TESTS (subprocess) ----------------------------------------
# ---------------------------------------------------------------------------

def test_non_guarded_tool_exit_0():
    """Case 1: Non-guarded tool -> exit 0, no stderr."""
    payload = {
        "tool_name": "Bash",
        "tool_input": {"command": "echo hello"},
        "cwd": "/home/domin/marveen",
    }
    rc, stderr = run_hook(payload)
    assert rc == 0, "Expected exit 0 for non-guarded tool"
    assert "EPISTEMIC" not in stderr, "No WARN for non-guarded tool"
    print("PASS test_non_guarded_tool_exit_0")


def test_guarded_contradiction_no_verify_warns():
    """Case 2: Guarded reply, contradiction+number, no verify -> exit 0 + WARN."""
    text = "Valójában a projekt 42 napig tartott, nem 30."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Mennyi ideig tartott?"},
        {"role": "assistant", "text": "A projekt 30 napig tartott."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0, "Should exit 0 (fail-open)"
    assert "EPISTEMIC-GATE WARN" in stderr, "Should WARN: '{}'".format(stderr)
    assert "Vaj" in stderr or "al" in stderr.lower() or "j" in stderr, \
        "WARN should name the trigger phrase: '{}'".format(stderr)
    print("PASS test_guarded_contradiction_no_verify_warns")


def test_guarded_contradiction_with_read_tool_no_warn():
    """Case 3: Same reply, transcript turn has tool_use:Read -> no WARN."""
    text = "Valójában a projekt 42 napig tartott, nem 30."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Mennyi ideig tartott?"},
        {"role": "assistant", "tool_uses": [{"name": "Read", "input": {"file_path": "/tmp/project.txt"}}]},
        {"role": "assistant", "text": "A projekt 42 napig tartott."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0
    assert "WARN" not in stderr, "Should NOT warn when Read tool is present"
    print("PASS test_guarded_contradiction_with_read_tool_no_warn")


def test_guarded_contradiction_with_bash_db_no_warn():
    """Case 4: Transcript turn has Bash reading noa.db -> no WARN."""
    text = "Valójában a feladatok száma 15, nem 10."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Hány feladat van?"},
        {"role": "assistant", "tool_uses": [
            {"name": "Bash", "input": {"command": "sqlite3 store/noa.db 'SELECT count(*) FROM kanban_cards'"}}
        ]},
        {"role": "assistant", "text": "15 feladat van."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0
    assert "WARN" not in stderr, "Should NOT warn when Bash reads DB"
    print("PASS test_guarded_contradiction_with_bash_db_no_warn")


def test_hedge_nem_tudom_never_warns():
    """Case 5: Reply contains 'nem tudom' -> never WARN even with contradiction+number."""
    text = "Valójában nem tudom pontosan, de valami 42 körül."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Melyik érték helyes?"},
        {"role": "assistant", "text": "Nem tudom biztosan."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0
    assert "WARN" not in stderr, "Hedged reply should NEVER warn"
    print("PASS test_hedge_nem_tudom_never_warns")


def test_negative_corpus_no_warn():
    """Case 6: 12+ ordinary Boss-facing replies -> zero WARN."""
    normal_replies = [
        "Elkészült a PR, linkje: https://github.com/Bigi-HS/marveen/pull/999",
        "Lefuttatam a teszteket, mind zöld.",
        "Az adatbázisban 5 rekord található a kanban táblában.",
        "Holnap 10:00-kor lesz a meeting.",
        "A build időtartama 2 perc volt.",
        "Megértettem, továbblépek.",
        "A szerver port 3420-on fut.",
        "Kész vagyok a feladattal.",
        "Az új branch neve: feat/ci-local-parity-runner-24b12610",
        "scripts/hooks/guardrail-name-gate.py:17 szerint ez fail-open.",
        "Az API endpoint: http://localhost:3420/api/kanban",
        "Összesen 3 változtatás: src/db.ts, scripts/hooks/x.py, .claude/settings.json",
        "2026-11-15-én deploy-olva lett. Ez rendben van.",  # date but no marker
        "A commit SHA: f60643e",
        "Nem tudom, hogy pontosan mikor volt, de az ideje 14:00 körül lehetett.",
    ]
    transcript = make_transcript([
        {"role": "user", "text": "Kérdés"},
        {"role": "assistant", "text": "Válasz"},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        for i, reply in enumerate(normal_replies):
            payload = make_reply_payload(reply)
            rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
            assert rc == 0, f"Reply {i} gave non-0 exit: {reply!r}"
            assert "WARN" not in stderr, f"Reply {i} gave WARN: {reply!r}\nstderr: {stderr}"
    print("PASS test_negative_corpus_no_warn ({} replies)".format(len(normal_replies)))


def test_flag_appends_one_row():
    """Case 7: Flagged event appends exactly one row to epistemic_claim_log with had_verify=0."""
    text = "Valójában a feladat 7 napja van nyitva, nem 3."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Mióta nyitva?"},
        {"role": "assistant", "text": "3 napja."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
        assert rc == 0
        assert "WARN" in stderr, "Should have warned"
        # Check DB
        con = sqlite3.connect(db_path)
        rows = con.execute("SELECT had_verify, trigger_phrase FROM epistemic_claim_log").fetchall()
        con.close()
        assert len(rows) == 1, "Expected exactly 1 row, got {}".format(len(rows))
        assert rows[0][0] == 0, "had_verify should be 0"
        print("PASS test_flag_appends_one_row (trigger='{}')".format(rows[0][1]))


def test_db_failure_still_warns():
    """Case 8: Forced DB write failure (unwritable path) -> still exit 0 + WARN."""
    text = "Valójában a projekt 42 napig tartott, nem 30."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Mennyi ideig?"},
        {"role": "assistant", "text": "30 napig."},
    ])
    # Point LEDGER_DB_PATH to an unwritable path
    bad_db_path = "/proc/no-write-access.db"
    rc, stderr = run_hook(payload, db_path=bad_db_path, transcript_content=transcript)
    assert rc == 0, "Should still exit 0 despite DB failure"
    assert "EPISTEMIC-GATE WARN" in stderr, "Should still WARN despite DB failure"
    print("PASS test_db_failure_still_warns")


def test_malformed_stdin():
    """Case 9: Malformed stdin -> exit 0, no stderr."""
    env = os.environ.copy()
    result = subprocess.run(
        [sys.executable, HOOK_PATH],
        input="not-json-at-all{{{",
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, "Malformed stdin should exit 0"
    assert "EPISTEMIC" not in result.stderr, "No WARN for malformed stdin"
    print("PASS test_malformed_stdin")


def test_turn_window_boundary(tmp_path):
    """Case 10: Verify tool BEFORE the last user turn does NOT count as grounding."""
    text = "Valójában a projekt 42 napig tartott, nem 30."
    payload = make_reply_payload(text)
    # Transcript: user1 -> Read verify -> user2 -> assistant (no verify)
    transcript = make_transcript([
        {"role": "user", "text": "Első kérdés"},
        {"role": "assistant", "tool_uses": [{"name": "Read", "input": {"file_path": "/tmp/x"}}]},
        {"role": "user", "text": "Második kérdés"},  # <-- last real user
        {"role": "assistant", "text": "Valasz"},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0
    assert "WARN" in stderr, "Verify before last user turn should NOT ground the claim"
    print("PASS test_turn_window_boundary")


def test_actually_english_contradiction():
    """'actually' + number fires for English group replies."""
    text = "Actually the meeting lasted 3 hours, not 2."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "How long?"},
        {"role": "assistant", "text": "2 hours."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0
    assert "WARN" in stderr, "English 'actually' should trigger"
    print("PASS test_actually_english_contradiction")


def test_number_in_code_path_no_warn():
    """A number only appearing in a code-span or path is not counted as numeric evidence."""
    # The "nem igaz" is here but the only digits are inside a code span / URL -- should not fire
    text = "Nem igaz, hogy az endpoint `http://localhost:3420/api/v2` nem működik."
    payload = make_reply_payload(text)
    transcript = make_transcript([
        {"role": "user", "text": "Az endpoint nem megy."},
        {"role": "assistant", "text": "Dehogynem."},
    ])
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "test.db")
        rc, stderr = run_hook(payload, db_path=db_path, transcript_content=transcript)
    assert rc == 0
    # The URL contains digits but they are in a URL span -> should NOT warn
    assert "WARN" not in stderr, (
        "Numbers only in URL/code-span should not trigger; got: {}".format(stderr)
    )
    print("PASS test_number_in_code_path_no_warn")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_all():
    import tempfile, pathlib

    with tempfile.TemporaryDirectory() as td:
        td_path = pathlib.Path(td)

        # Unit tests that need tmp_path
        test_has_ground_truth_read_tool(td_path)
        test_has_ground_truth_grep_tool(td_path)
        test_has_ground_truth_bash_db(td_path)
        test_has_ground_truth_no_verify(td_path)
        test_has_ground_truth_before_last_user_does_not_count(td_path)

    # Pure unit tests (no filesystem)
    test_find_claim_trigger_basic()
    test_find_claim_trigger_nem_igaz()
    test_find_claim_trigger_tevedsz()
    test_find_claim_trigger_no_number()
    test_find_claim_trigger_question_skipped()
    test_find_claim_trigger_quoted_skipped()
    test_is_hedged_true()
    test_is_hedged_false()

    # Integration tests (subprocess)
    test_non_guarded_tool_exit_0()
    test_guarded_contradiction_no_verify_warns()
    test_guarded_contradiction_with_read_tool_no_warn()
    test_guarded_contradiction_with_bash_db_no_warn()
    test_hedge_nem_tudom_never_warns()
    test_negative_corpus_no_warn()
    test_flag_appends_one_row()
    test_db_failure_still_warns()
    test_malformed_stdin()
    test_turn_window_boundary(None)  # uses run_hook's tempdir internally
    test_actually_english_contradiction()
    test_number_in_code_path_no_warn()

    print("\nAll tests PASSED.")


if __name__ == "__main__":
    run_all()
