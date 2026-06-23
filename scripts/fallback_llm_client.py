#!/usr/bin/env python3
"""Degraded-reasoning fallback LLM client (token-outage survival, Layer 2).

Card 92f07145. Spec: store/spec-layer2-fallback-llm.md (Quill, thor-gated v2).

Layer 1 (direct-send.py, merged) delivers pre-written template messages without
Claude. Layer 2 adds thin, single-shot, cloud-hosted reasoning for the narrow
class of tasks that need structured output but no fleet memory or tool-use loops:
parse a reminder, triage a kanban card, write a short coaching reply.

The schedule-runner invokes this script (instead of injecting into the frozen
Claude tmux session) when ALL hold: store/token-outage-state.json `limited:true`,
the task's task-config.json `layer2:true`, and Layer 1 was NOT invoked for the
task (directSend != true). See AC-1.

Provider routing is sensitivity-driven (AC-2, F1 Option B): "high"/"medium" ->
Groq only; "low" -> Groq then Gemini. Sensitivity defaults to "high" when absent
(fail-safe). Keys come from env vars named in the YAML, never hardcoded, never
logged (AC-6). base_url is checked against a hardcoded allowlist (AC-7). Every
outcome is logged to layer2_call_log with a per-outage call budget (AC-9). All
Layer-2 output is labelled [Fallback] / [Layer-2 fallback ...] (AC-10).

Dependencies: Python stdlib + PyYAML for config. The completion call is a single
stdlib `urllib.request` POST to the provider's OpenAI-compatible /chat/completions
endpoint -- no `openai` SDK. This is deliberate (Thor gate B1): the SDK is NOT
installed in the fleet Python env, and a survival-mode component must not depend
on a package that may be missing exactly when it is needed. Going stdlib-only
keeps Layer 2 dependency-free like Layer 1, with no deploy-time install step and
no venv fragility, and obsoletes the earlier OQ-4 import guard. Unit tests inject
a fake `completion` callable (and the HTTP path injects a fake opener), so the
suite is network-free.

Run tests: python3 scripts/test_fallback_llm_client.py

Exit codes:
  0  produced output (sent a message / created a card) successfully
  1  config error or a non-retryable skip (unknown task type, no eligible/usable
     provider, budget exhausted, invalid/schema-mismatched response) -- nothing
     useful happened and an immediate retry would not help; the tick is consumed
  2  transient delivery failure (Telegram network error / kanban DB write error)
     where a later tick in the same outage window may succeed
"""
import argparse
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

import yaml

# --- AC-7: base_url allowlist. A constant in code; the YAML cannot widen it. ---
ALLOWED_BASE_URLS = frozenset({
    "https://api.groq.com/openai/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
    "https://openrouter.ai/api/v1",
})

DEFAULT_MAX_CALLS_PER_OUTAGE = 50

# AC-3 / AC-10: only these three task types are supported. Anything else is
# rejected at parse time before any API call.
VALID_TASK_TYPES = frozenset({"kanban_card_from_text", "reminder_parse", "coaching_reply"})

VALID_SENSITIVITY = frozenset({"low", "medium", "high"})
DEFAULT_SENSITIVITY = "high"  # AC-2 / T2: absent or invalid -> fail safe (Groq-only).

VALID_PRIORITIES = frozenset({"low", "normal", "high", "urgent"})

COACHING_MAX_CHARS = 500  # AC-3 / AC-8.

# AC-10: mandatory degraded-output labels.
FALLBACK_MSG_PREFIX = "[Fallback] "
FALLBACK_CARD_PREFIX = "[Layer-2 fallback — verify before acting]\n"

# Operator chat id whitelist (reused from Layer 1; M4).
KNOWN_CHAT_IDS = {"8643929442"}
DEFAULT_CHAT_ID = "8643929442"

# 5.5: coaching_reply with health/medical/financial content is reclassified to
# "high" (defence-in-depth) regardless of the configured sensitivity, so it is
# Groq-only with redaction and never reaches Gemini.
# Hungarian is agglutinative, so the HU branch matches STEMS without a trailing
# word boundary (e.g. "vércuk" catches "vércukor"/"vércukrom"/"vércukrot"). Over-
# matching is the safe direction here: it only ever pushes a task to "high"
# (Groq + redaction), never the other way. English keeps full-word boundaries.
_HEALTH_FINANCE_RE = re.compile(
    r"(?:eg[eé]szs[eé]g|orvos|gy[oó]gyszer|v[eé]rcuk|s[uú]ly|kal[oó]r|p[eé]nz|sz[aá]ml|bank)"
    r"|\b(?:health|medical|doctor|medicine|blood\s*sugar|weight|calorie|money|invoice)\b",
    re.IGNORECASE,
)

# --- AC-5: redaction patterns (high-sensitivity Groq calls only). ---
# Names: a capitalised word (Hungarian or English). Intentionally over-redacts
# common nouns (Budapest, Január) -- an accepted safe trade-off (F7). OQ-2:
# the English [A-Z][a-z]{2,} branch is included for Hibiki/English-tutor tasks.
_NAME_RE = re.compile(r"\b(?:[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]{2,})\b")
# Numbers with a unit (weights / measurements / energy).
_UNIT_RE = re.compile(r"\b\d+[\.,]?\d*\s*(?:kg|cm|mg|kcal)\b", re.IGNORECASE)
# ISO dates.
_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")


# --------------------------------------------------------------------------- #
# Config loading
# --------------------------------------------------------------------------- #
def load_providers(yaml_text):
    """Parse the provider YAML. Returns (providers, max_calls, dropped) where
    `providers` keeps only entries whose base_url is on ALLOWED_BASE_URLS (AC-7),
    in declared order, and `dropped` lists the names of rejected providers (for a
    logged warning). A malformed YAML yields ([], default_max, [])."""
    try:
        doc = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        return [], DEFAULT_MAX_CALLS_PER_OUTAGE, []
    if not isinstance(doc, dict):
        return [], DEFAULT_MAX_CALLS_PER_OUTAGE, []

    raw_max = doc.get("max_calls_per_outage", DEFAULT_MAX_CALLS_PER_OUTAGE)
    max_calls = raw_max if isinstance(raw_max, int) and raw_max > 0 else DEFAULT_MAX_CALLS_PER_OUTAGE

    providers = []
    dropped = []
    for entry in doc.get("providers", []) or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "")
        base_url = str(entry.get("base_url") or "")
        if base_url not in ALLOWED_BASE_URLS:
            dropped.append(name or base_url)
            continue
        providers.append({
            "name": name,
            "base_url": base_url,
            "model": str(entry.get("model") or ""),
            "api_key_env": str(entry.get("api_key_env") or ""),
            "sensitive_ok": entry.get("sensitive_ok") is True,
        })
    return providers, max_calls, dropped


def select_providers(providers, sensitivity):
    """AC-2 (F1 Option B): order eligible providers for a sensitivity level.
    high/medium -> only sensitive_ok providers (Gemini excluded). low -> all
    providers in declared order. The list is never escalated in sensitivity."""
    if sensitivity in ("high", "medium"):
        return [p for p in providers if p["sensitive_ok"]]
    return list(providers)  # "low": Groq primary, Gemini secondary, per YAML order.


def classify_sensitivity(config_sensitivity, task_type, input_text):
    """Resolve the effective sensitivity. Absent/invalid -> "high" (AC-2/T2).
    coaching_reply with health/medical/financial keywords is forced to "high"
    (5.5 defence-in-depth) regardless of the configured value."""
    sens = config_sensitivity if config_sensitivity in VALID_SENSITIVITY else DEFAULT_SENSITIVITY
    if task_type == "coaching_reply" and _HEALTH_FINANCE_RE.search(input_text or ""):
        return "high"
    return sens


# --------------------------------------------------------------------------- #
# Redaction (AC-5)
# --------------------------------------------------------------------------- #
def redact(text):
    """Replace dates, unit-numbers and capitalised names with sequential
    placeholders. Returns (redacted_text, mapping placeholder->original). The
    mapping is in-memory only and must never be logged or persisted. Applied in
    order date -> unit -> name so a unit number is not first eaten by a name."""
    mapping = {}
    counters = {"D": 0, "W": 0, "P": 0}

    def sub(pattern, tag, s):
        def repl(m):
            counters[tag] += 1
            ph = "[{}{}]".format(tag, counters[tag])
            mapping[ph] = m.group(0)
            return ph
        return pattern.sub(repl, s)

    out = sub(_DATE_RE, "D", text)
    out = sub(_UNIT_RE, "W", out)
    out = sub(_NAME_RE, "P", out)
    return out, mapping


_PLACEHOLDER_RE = re.compile(r"\[[DWP]\d+\]")


def restore(text, mapping):
    """Reverse-substitute placeholders. Known placeholders are restored; any
    leftover placeholder-shaped token not in the map is dropped silently (a
    shorter/partial response is acceptable, per AC-5)."""
    def repl(m):
        return mapping.get(m.group(0), "")
    return _PLACEHOLDER_RE.sub(repl, text)


# --------------------------------------------------------------------------- #
# Request building + response validation
# --------------------------------------------------------------------------- #
_KANBAN_TOOL = {
    "type": "function",
    "function": {
        "name": "create_kanban_card",
        "description": "Create a kanban card from the user's free text.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["title", "description", "priority", "assignee"],
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "priority": {"type": "string", "enum": sorted(VALID_PRIORITIES)},
                "assignee": {"type": "string"},
            },
        },
    },
}


def build_request(task_type, input_text):
    """Return (messages, tools) for a single completion call. tools is None for
    the plain-text / JSON-only task types."""
    if task_type == "kanban_card_from_text":
        messages = [
            {"role": "system", "content": "Extract a single kanban card from the user's text. "
                                          "Call create_kanban_card exactly once. priority is one of "
                                          "low/normal/high/urgent; assignee is an agent id or empty."},
            {"role": "user", "content": input_text},
        ]
        return messages, [_KANBAN_TOOL]
    if task_type == "reminder_parse":
        messages = [
            {"role": "system", "content": "Parse the reminder. Respond with ONLY a JSON object "
                                          '{"datetime_iso": "<ISO 8601>", "message": "<text>"} and nothing else.'},
            {"role": "user", "content": input_text},
        ]
        return messages, None
    # coaching_reply
    messages = [
        {"role": "system", "content": "Write a brief, supportive coaching reply in plain text, "
                                      "max 500 characters. No markdown headings."},
        {"role": "user", "content": input_text},
    ]
    return messages, None


def _strip_code_fence(s):
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s)
    return s.strip()


def validate_kanban_card(obj):
    """Return a normalised card dict or raise ValueError. priority defaults to
    'normal' if missing/invalid; assignee may be empty."""
    if not isinstance(obj, dict):
        raise ValueError("not an object")
    title = obj.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title required")
    description = obj.get("description")
    if not isinstance(description, str):
        description = ""
    priority = obj.get("priority")
    if priority not in VALID_PRIORITIES:
        priority = "normal"
    assignee = obj.get("assignee")
    if not isinstance(assignee, str):
        assignee = ""
    return {"title": title.strip(), "description": description, "priority": priority, "assignee": assignee.strip()}


def validate_reminder(obj):
    """Return {datetime_iso, message} or raise ValueError."""
    if not isinstance(obj, dict):
        raise ValueError("not an object")
    dt = obj.get("datetime_iso")
    msg = obj.get("message")
    if not isinstance(dt, str) or not dt.strip():
        raise ValueError("datetime_iso required")
    if not isinstance(msg, str) or not msg.strip():
        raise ValueError("message required")
    return {"datetime_iso": dt.strip(), "message": msg.strip()}


# --------------------------------------------------------------------------- #
# Provider call (DI for tests)
# --------------------------------------------------------------------------- #
class ProviderRateLimited(Exception):
    """Raised by a completion callable for an HTTP 429 / rate-limit condition."""


class ProviderUnavailable(Exception):
    """Raised by a completion callable for any other transport/API failure."""


def _http_completion(base_url, api_key, model, messages, tools, opener=urllib.request.urlopen):
    """Default completion callable: ONE single-shot POST to the provider's
    OpenAI-compatible /chat/completions endpoint via stdlib urllib (AC-4). No SDK
    (Thor B1). Bearer auth; the key travels only in the request header and is
    never logged or placed in any raised message. Maps HTTP 429 to
    ProviderRateLimited and every other transport/HTTP/parse failure to
    ProviderUnavailable. The opener is injectable so the HTTP path is testable
    without a network. Returns the assistant text, or for a tool call the tool
    arguments JSON string."""
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {"model": model, "messages": messages, "temperature": 0}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "required"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    try:
        resp = opener(req, timeout=45)
        try:
            body = resp.read().decode("utf-8")
        finally:
            close = getattr(resp, "close", None)
            if close:
                close()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise ProviderRateLimited("http 429")
        raise ProviderUnavailable("http {}".format(e.code))
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise ProviderUnavailable(str(e))

    try:
        doc = json.loads(body)
        msg = doc["choices"][0]["message"]
        if tools and msg.get("tool_calls"):
            return msg["tool_calls"][0]["function"]["arguments"]
        return msg.get("content") or ""
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise ProviderUnavailable("malformed response: {}".format(e))


def resolve_api_key(provider):
    """AC-6: resolve the key by env-var NAME only. Returns None if unset/empty."""
    name = provider.get("api_key_env") or ""
    if not name:
        return None
    val = os.environ.get(name)
    return val if val else None


# --------------------------------------------------------------------------- #
# DB: layer2_call_log + budget (AC-9)
# --------------------------------------------------------------------------- #
def _connect(db_path):
    return sqlite3.connect(db_path, timeout=5)


def ensure_log_table(con):
    con.execute(
        """CREATE TABLE IF NOT EXISTS layer2_call_log (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               task_name TEXT NOT NULL,
               agent TEXT,
               provider TEXT,
               model TEXT,
               task_type TEXT,
               status TEXT NOT NULL,
               reason TEXT,
               warning TEXT,
               outage_started_at INTEGER,
               logged_at INTEGER NOT NULL
           )"""
    )


def log_row(db_path, **row):
    """Append one row to layer2_call_log (created on first use). Bound params
    (AC-8). Never receives a prompt or key column (AC-6/I3). Returns True/False;
    a failed log is non-fatal and never carries the key/prompt."""
    try:
        con = _connect(db_path)
        try:
            ensure_log_table(con)
            con.execute(
                "INSERT INTO layer2_call_log "
                "(task_name, agent, provider, model, task_type, status, reason, warning, outage_started_at, logged_at) "
                "VALUES (:task_name, :agent, :provider, :model, :task_type, :status, :reason, :warning, :outage_started_at, :logged_at)",
                {
                    "task_name": row.get("task_name"),
                    "agent": row.get("agent"),
                    "provider": row.get("provider"),
                    "model": row.get("model"),
                    "task_type": row.get("task_type"),
                    "status": row.get("status"),
                    "reason": row.get("reason"),
                    "warning": row.get("warning"),
                    "outage_started_at": row.get("outage_started_at"),
                    "logged_at": row.get("logged_at"),
                },
            )
            con.commit()
            return True
        finally:
            con.close()
    except sqlite3.Error:
        return False


def count_budget(db_path, outage_started_at):
    """AC-9: count Layer-2 calls in the current outage window. Only rows that
    actually hit a provider count: status IN ('sent','error') AND provider IS NOT
    NULL. Config-parse skips / rate-limit skips (provider NULL) do not count."""
    try:
        con = _connect(db_path)
        try:
            ensure_log_table(con)
            cur = con.execute(
                "SELECT COUNT(*) FROM layer2_call_log "
                "WHERE outage_started_at IS ? AND status IN ('sent','error') AND provider IS NOT NULL",
                (outage_started_at,),
            )
            return int(cur.fetchone()[0])
        finally:
            con.close()
    except sqlite3.Error:
        return 0


# --------------------------------------------------------------------------- #
# Downstream writes
# --------------------------------------------------------------------------- #
def insert_kanban_card(db_path, card, now, id_factory):
    """Insert a Layer-2 card with the mandatory degraded label (AC-10). Returns
    the new id, or None on DB error (caller maps to a transient failure)."""
    try:
        con = _connect(db_path)
        try:
            card_id = id_factory()
            con.execute(
                "INSERT INTO kanban_cards (id, title, description, status, assignee, priority, created_at, updated_at, sort_order) "
                "VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, 0)",
                (
                    card_id,
                    card["title"],
                    FALLBACK_CARD_PREFIX + card["description"],
                    card["assignee"] or None,
                    card["priority"],
                    now,
                    now,
                ),
            )
            con.commit()
            return card_id
        finally:
            con.close()
    except sqlite3.Error:
        return None


# --------------------------------------------------------------------------- #
# Task input
# --------------------------------------------------------------------------- #
def extract_task_input(skill_md):
    """The free-text input fed to the model. Prefers a `## Layer-2 Input`
    section (symmetry with Layer 1's `## Direct Message`); otherwise the whole
    SKILL.md body with any leading YAML front-matter stripped. Returns '' when
    nothing usable remains."""
    section = _extract_section(skill_md, "## Layer-2 Input")
    if section:
        return section
    body = skill_md
    if body.startswith("---"):
        parts = body.split("\n---", 1)
        if len(parts) == 2:
            body = parts[1]
    return body.strip()


def _extract_section(skill_md, header):
    lines = skill_md.splitlines()
    out = []
    in_section = False
    for line in lines:
        if not in_section:
            if line.strip() == header:
                in_section = True
            continue
        if line.lstrip().startswith("##"):
            break
        out.append(line)
    if not in_section:
        return None
    return "\n".join(out).strip() or None


# --------------------------------------------------------------------------- #
# Reused Layer-1 Telegram sender (OQ-1: DRY, reuse the tested send path)
# --------------------------------------------------------------------------- #
_direct_send_cache = None


def _direct_send():
    global _direct_send_cache
    if _direct_send_cache is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "direct-send.py")
        spec = importlib.util.spec_from_file_location("direct_send", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _direct_send_cache = mod
    return _direct_send_cache


def _default_sender(token, chat_id, text):
    return _direct_send().telegram_send(token, chat_id, text)


def _default_token_loader(env_text):
    return _direct_send().load_token(env_text)


# --------------------------------------------------------------------------- #
# State
# --------------------------------------------------------------------------- #
def read_state(state_file):
    """Return (limited, outage_started_at). Absent/malformed -> (False, None)."""
    try:
        with open(state_file, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return False, None
    if not isinstance(doc, dict):
        return False, None
    limited = doc.get("limited") is True
    started = doc.get("enteredAtMs")
    if not isinstance(started, int):
        started = None
    return limited, started


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv=None, completion=_http_completion, sender=None, token_loader=None, now=None, id_factory=None):
    parser = argparse.ArgumentParser(description="Degraded-reasoning fallback LLM client (token-outage Layer 2)")
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--providers-yaml", default="/home/domin/marveen/store/fallback-llm-providers.yaml")
    parser.add_argument("--db-path", default="/home/domin/marveen/store/claudeclaw.db")
    parser.add_argument("--state-file", default="/home/domin/marveen/store/token-outage-state.json")
    parser.add_argument("--env-file", default="/home/domin/marveen/.env")
    parser.add_argument("--chat-id", default=None)
    args = parser.parse_args(argv)

    if now is None:
        now = int(time.time())
    if sender is None:
        sender = _default_sender
    if token_loader is None:
        token_loader = _default_token_loader
    if id_factory is None:
        id_factory = lambda: os.urandom(4).hex()

    task_dir = args.task_dir
    task_name = os.path.basename(os.path.normpath(task_dir))

    limited, outage_started_at = read_state(args.state_file)

    config = _read_json(os.path.join(task_dir, "task-config.json"))
    agent = str(config.get("agent") or "unknown")
    task_type = config.get("layer2_task_type")
    config_sensitivity = config.get("sensitivity")

    def emit(status, reason, warning, provider=None, model=None, task_type_override=None):
        ok = log_row(
            args.db_path,
            task_name=task_name, agent=agent,
            provider=provider, model=model,
            task_type=task_type_override if task_type_override is not None else task_type,
            status=status, reason=reason, warning=warning,
            outage_started_at=outage_started_at, logged_at=now,
        )
        if not ok:
            sys.stderr.write("fallback-llm: WARN failed to write layer2_call_log row\n")

    # AC-11 defence: the runner gates on limited:true, but never act if not.
    if not limited:
        emit("skipped", "not_limited", None)
        return 1

    # AC-3: reject an unknown/missing task type before any API call (no budget).
    if task_type not in VALID_TASK_TYPES:
        emit("error", "unknown_task_type", None)
        return 1

    input_text = extract_task_input(_read_text(os.path.join(task_dir, "SKILL.md")))
    if not input_text:
        emit("skipped", "no_input", None)
        return 1

    sensitivity = classify_sensitivity(config_sensitivity, task_type, input_text)

    providers, max_calls, dropped = load_providers(_read_text(args.providers_yaml))
    if dropped:
        # AC-7 / S2: a base_url not on the allowlist is dropped with a logged warning.
        sys.stderr.write("fallback-llm: WARN url_not_allowed, dropped provider(s): {}\n".format(", ".join(dropped)))
    if not providers:
        # M1: distinguish "every provider URL was off the allowlist"
        # (url_not_allowed) from a genuinely missing/empty config
        # (provider_config_missing) -- two different operator faults.
        emit("skipped", "url_not_allowed" if dropped else "provider_config_missing", None)
        return 1
    eligible = select_providers(providers, sensitivity)
    if not eligible:
        emit("skipped", "no_eligible_provider", None)
        return 1

    # S1: a missing outage timestamp makes the per-outage budget window
    # meaningless, so skip BEFORE any API call (closes the D1 budget NULL bug).
    # The token-outage-bridge always writes enteredAtMs alongside limited:true;
    # its absence means a malformed state, not a real outage window.
    if outage_started_at is None:
        emit("skipped", "missing_outage_ts", None)
        return 1

    # AC-9: per-outage budget gate (before any API call).
    if count_budget(args.db_path, outage_started_at) >= max_calls:
        emit("skipped", "budget_exhausted", None)
        return 1

    # Build the single request; redact for high sensitivity (AC-5).
    messages, tools = build_request(task_type, input_text)
    redaction_map = {}
    if sensitivity == "high":
        red_input, redaction_map = redact(input_text)
        messages, tools = build_request(task_type, red_input)

    # AC-2/AC-4: try providers in order, ONE completion call each, first success wins.
    any_rate_limited = False
    any_unavailable = False
    any_key_missing = False
    used = None
    raw = None
    for p in eligible:
        key = resolve_api_key(p)
        if not key:
            any_key_missing = True
            continue
        try:
            raw = completion(p["base_url"], key, p["model"], messages, tools)
        except ProviderRateLimited:
            any_rate_limited = True
            continue
        except ProviderUnavailable:
            any_unavailable = True
            continue
        used = p
        break

    if used is None:
        if any_rate_limited and not any_unavailable:
            reason = "all_providers_rate_limited"
        elif any_key_missing and not (any_rate_limited or any_unavailable):
            reason = "no_api_key"
        else:
            reason = "groq_unavailable"
        emit("skipped", reason, None)
        return 1

    # Reverse-substitute before any parse/use (AC-5).
    if redaction_map:
        raw = restore(raw, redaction_map)

    # Validate + act per task type. A response that came back but fails to parse
    # is status='error' (provider set) so it counts toward budget; exit 1.
    if task_type == "kanban_card_from_text":
        try:
            card = validate_kanban_card(json.loads(_strip_code_fence(raw)))
        except (ValueError, TypeError):
            emit("error", _parse_reason(raw, "kanban"), None, provider=used["name"], model=used["model"])
            return 1
        card_id = insert_kanban_card(args.db_path, card, now, id_factory)
        if card_id is None:
            emit("error", "db_write_failed", None, provider=used["name"], model=used["model"])
            return 2
        emit("sent", None, None, provider=used["name"], model=used["model"])
        return 0

    if task_type == "reminder_parse":
        try:
            rem = validate_reminder(json.loads(_strip_code_fence(raw)))
        except (ValueError, TypeError):
            emit("error", _parse_reason(raw, "reminder"), None, provider=used["name"], model=used["model"])
            return 1
        text = "{}Reminder: {} — {}".format(FALLBACK_MSG_PREFIX, rem["datetime_iso"], rem["message"])
        return _send(args, sender, token_loader, text, emit, used, now)

    # coaching_reply
    reply = (raw or "").strip()
    if not reply:
        emit("error", "invalid_response", None, provider=used["name"], model=used["model"])
        return 1
    warning = None
    if len(reply) > COACHING_MAX_CHARS:
        reply = reply[:COACHING_MAX_CHARS]
        warning = "truncated"
    text = FALLBACK_MSG_PREFIX + reply
    return _send(args, sender, token_loader, text, emit, used, now, warning=warning)


def _send(args, sender, token_loader, text, emit, used, now, warning=None):
    """Send a [Fallback] Telegram message via the reused Layer-1 path. Maps a
    network/non-200 result to exit 2 (transient)."""
    chat_id = str(args.chat_id or DEFAULT_CHAT_ID)
    if chat_id not in KNOWN_CHAT_IDS:
        emit("error", "invalid_chat_id", warning, provider=used["name"], model=used["model"])
        return 1
    token = token_loader(_read_text(args.env_file))
    if not token:
        emit("error", "no_token", warning, provider=used["name"], model=used["model"])
        return 1
    code = sender(token, chat_id, text)
    if code != 200:
        reason = "telegram_network" if code == -1 else "telegram_{}".format(code)
        emit("error", reason, warning, provider=used["name"], model=used["model"])
        return 2
    emit("sent", None, warning, provider=used["name"], model=used["model"])
    return 0


def _parse_reason(raw, kind):
    """schema_mismatch when it parsed as JSON but failed validation;
    invalid_response when it was not valid JSON at all (AC-4/AC-8)."""
    try:
        json.loads(_strip_code_fence(raw))
        return "schema_mismatch"
    except (ValueError, TypeError):
        return "invalid_response"


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


if __name__ == "__main__":
    sys.exit(main())
