#!/usr/bin/env python3
"""ANOX — team performance platform (pilot server).

Standard library only: http.server + sqlite3.

Data provenance is a first-class field. Every activity carries a `source`:
  demo   — generated sample data (seed-demo command only)
  manual — typed in through the UI
  csv    — imported from a CSV file
  device — reserved for a future device/app adapter. No adapter exists yet:
           the API never accepts `device` from a client. See docs/device-integration.md.

Usage:
  python3 server.py                     # serve on 127.0.0.1:8001
  python3 server.py create-owner        # create the platform owner account (interactive)
  python3 server.py seed-demo           # add clearly-labelled demo teams
"""

import base64
import csv
import getpass
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("ANOX_DB", os.path.join(ROOT, ".local", "anox.sqlite3"))
HOST = os.environ.get("ANOX_HOST", "127.0.0.1")
PORT = int(os.environ.get("ANOX_PORT", "8001"))
PBKDF2_ITERATIONS = int(os.environ.get("ANOX_PBKDF2_ITERATIONS", "310000"))
SESSION_HOURS = int(os.environ.get("ANOX_SESSION_HOURS", "12"))
COOKIE_SECURE = os.environ.get("ANOX_COOKIE_SECURE") == "1"
COOKIE_NAME = "anox_session"
MAX_BODY = 2 * 1024 * 1024
LOGIN_WINDOW_MIN = 15
LOGIN_MAX_PER_EMAIL = 5
LOGIN_MAX_PER_IP = 20

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/demo.js": ("demo.js", "application/javascript; charset=utf-8"),
}

POSITIONS = {"GK", "DEF", "MID", "FWD"}
POSITION_ALIASES = {
    "gk": "GK", "שוער": "GK",
    "def": "DEF", "df": "DEF", "הגנה": "DEF", "מגן": "DEF", "בלם": "DEF",
    "mid": "MID", "mf": "MID", "קישור": "MID", "קשר": "MID",
    "fwd": "FWD", "fw": "FWD", "התקפה": "FWD", "חלוץ": "FWD",
}
KINDS = {"training", "match"}
KIND_ALIASES = {"training": "training", "אימון": "training", "match": "match", "משחק": "match"}
CLIENT_SOURCES = {"manual", "csv"}  # what a client may create; "demo"/"device" are server-side only
PLANS = {"pilot", "trial", "paid"}
TEAM_STATUSES = {"active", "suspended"}

# Plausibility limits for a single player in a single activity.
LIMITS = {
    "distance_km": (0, 20),
    "max_speed_kmh": (0, 45),
    "sprints": (0, 200),
    "minutes": (0, 240),
}

_db_init_lock = threading.Lock()


# ---------------------------------------------------------------- errors

class ApiError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details


def bad_request(message, details=None):
    return ApiError(400, message, details)


# ---------------------------------------------------------------- database

SCHEMA = [
    # version 1
    """
    CREATE TABLE teams (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
        plan TEXT NOT NULL DEFAULT 'pilot' CHECK (plan IN ('pilot','trial','paid')),
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner','manager')),
        team_id INTEGER REFERENCES teams(id),
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        CHECK ((role = 'owner' AND team_id IS NULL) OR (role = 'manager' AND team_id IS NOT NULL))
    );
    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );
    CREATE TABLE players (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        name TEXT NOT NULL,
        position TEXT NOT NULL CHECK (position IN ('GK','DEF','MID','FWD')),
        number INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at TEXT NOT NULL
    );
    CREATE INDEX players_team ON players(team_id);
    CREATE TABLE devices (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        label TEXT NOT NULL,
        serial TEXT,
        model TEXT NOT NULL DEFAULT 'AT01',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
        created_at TEXT NOT NULL
    );
    CREATE TABLE device_assignments (
        id INTEGER PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES devices(id),
        player_id INTEGER NOT NULL REFERENCES players(id),
        assigned_at TEXT NOT NULL,
        released_at TEXT
    );
    CREATE UNIQUE INDEX one_open_assignment_per_device ON device_assignments(device_id) WHERE released_at IS NULL;
    CREATE UNIQUE INDEX one_open_assignment_per_player ON device_assignments(player_id) WHERE released_at IS NULL;
    CREATE TABLE import_batches (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        source TEXT NOT NULL CHECK (source IN ('csv','device')),
        filename TEXT,
        row_count INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
    );
    CREATE TABLE activities (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        date TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('training','match')),
        title TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('demo','manual','csv','device')),
        import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE CASCADE,
        notes TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
    );
    CREATE INDEX activities_team_date ON activities(team_id, date);
    CREATE TABLE activity_metrics (
        id INTEGER PRIMARY KEY,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id),
        distance_km REAL,
        max_speed_kmh REAL,
        sprints INTEGER,
        minutes REAL,
        UNIQUE (activity_id, player_id)
    );
    CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        user_id INTEGER,
        team_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX audit_team ON audit_log(team_id, at);
    CREATE TABLE login_failures (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        ip TEXT NOT NULL,
        at TEXT NOT NULL
    );
    """,
]


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(path=None):
    path = path or DB_PATH
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path=None):
    path = path or DB_PATH
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with _db_init_lock:
        conn = connect(path)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            for i, script in enumerate(SCHEMA[version:], start=version + 1):
                conn.executescript("BEGIN;" + script + f"PRAGMA user_version = {i}; COMMIT;")
        finally:
            conn.close()


def audit(conn, user_id, team_id, action, **detail):
    conn.execute(
        "INSERT INTO audit_log (at, user_id, team_id, action, detail) VALUES (?,?,?,?,?)",
        (now_iso(), user_id, team_id, action, json.dumps(detail, ensure_ascii=False)),
    )


# ---------------------------------------------------------------- passwords & sessions

def hash_password(password, iterations=None):
    iterations = iterations or PBKDF2_ITERATIONS
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations, base64.b64encode(salt).decode(), base64.b64encode(digest).decode()
    )


def verify_password(password, stored):
    try:
        algo, iterations, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt_b64), int(iterations)
        )
        return hmac.compare_digest(digest, base64.b64decode(hash_b64))
    except (ValueError, TypeError):
        return False


def validate_new_password(password):
    if not isinstance(password, str) or len(password) < 10:
        raise bad_request("הסיסמה חייבת להכיל לפחות 10 תווים")
    if len(password) > 200:
        raise bad_request("הסיסמה ארוכה מדי")


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    created = datetime.now(timezone.utc)
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        (token_hash(token), user_id, created.isoformat(),
         (created + timedelta(hours=SESSION_HOURS)).isoformat()),
    )
    return token


def session_user(conn, token):
    if not token:
        return None
    row = conn.execute(
        """SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ?""",
        (token_hash(token),),
    ).fetchone()
    if not row:
        return None
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc) or not row["active"]:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        conn.commit()
        return None
    return row


# ---------------------------------------------------------------- validation helpers

def clean_text(value, field, max_len=120, required=True):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise bad_request(f"ערך לא תקין בשדה {field}")
    value = " ".join(value.split())
    if required and not value:
        raise bad_request(f"השדה {field} חובה")
    if len(value) > max_len:
        raise bad_request(f"השדה {field} ארוך מדי (עד {max_len} תווים)")
    return value


def clean_email(value):
    value = clean_text(value, "אימייל", 200).lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise bad_request("כתובת אימייל לא תקינה")
    return value


def parse_position(value):
    if value is None:
        return None
    v = str(value).strip()
    if v.upper() in POSITIONS:
        return v.upper()
    return POSITION_ALIASES.get(v.lower())


def parse_kind(value):
    if value is None:
        return None
    return KIND_ALIASES.get(str(value).strip().lower())


def parse_date(value, field="תאריך"):
    if isinstance(value, str):
        v = value.strip()
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y"):
            try:
                d = datetime.strptime(v, fmt).date()
                break
            except ValueError:
                continue
        else:
            d = None
        if d and date(2000, 1, 1) <= d <= date.today() + timedelta(days=1):
            return d.isoformat()
    raise bad_request(f"{field} לא תקין (נדרש YYYY-MM-DD, לא בעתיד)")


def parse_number(value):
    """Shirt number: empty -> None, otherwise 1..99."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        n = int(str(value).strip())
    except ValueError:
        raise bad_request("מספר חולצה חייב להיות מספר שלם")
    if not 1 <= n <= 99:
        raise bad_request("מספר חולצה חייב להיות בין 1 ל-99")
    return n


def parse_metric(value, key, label):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        n = float(str(value).strip().replace(",", "."))
    except ValueError:
        raise bad_request(f"{label}: ערך לא מספרי")
    lo, hi = LIMITS[key]
    if not lo <= n <= hi:
        raise bad_request(f"{label}: ערך מחוץ לטווח ({lo}–{hi})")
    if key == "sprints":
        if n != int(n):
            raise bad_request(f"{label}: חייב להיות מספר שלם")
        return int(n)
    return round(n, 2)


METRIC_FIELDS = [
    ("distance_km", "מרחק (ק״מ)"),
    ("max_speed_kmh", "מהירות שיא (קמ״ש)"),
    ("sprints", "ספרינטים"),
    ("minutes", "דקות"),
]


def parse_metrics(raw):
    out = {key: parse_metric(raw.get(key), key, label) for key, label in METRIC_FIELDS}
    if all(v is None for v in out.values()):
        return None
    return out


# ---------------------------------------------------------------- domain: teams & access

def team_row(conn, team_id):
    row = conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
    if not row:
        raise ApiError(404, "הקבוצה לא נמצאה")
    return row


def require_team_access(conn, user, team_id):
    """Owner: any team. Manager: only their own team, and only while it is active."""
    team = team_row(conn, team_id)
    if user["role"] == "owner":
        return team
    if user["team_id"] != team["id"]:
        # Do not reveal whether another team exists.
        raise ApiError(404, "הקבוצה לא נמצאה")
    if team["status"] != "active":
        raise ApiError(403, "הגישה לקבוצה מושהית. פנה למנהל הפלטפורמה.")
    return team


def team_dict(row, counts=None):
    d = {k: row[k] for k in ("id", "name", "status", "plan", "created_at")}
    d["is_demo"] = bool(row["is_demo"])
    if counts:
        d.update(counts)
    return d


def player_dict(row):
    return {k: row[k] for k in ("id", "name", "position", "number", "status", "created_at")}


def ensure_number_free(conn, team_id, number, exclude_player_id=None):
    if number is None:
        return
    row = conn.execute(
        "SELECT id, name FROM players WHERE team_id = ? AND number = ? AND status = 'active' AND id != ?",
        (team_id, number, exclude_player_id or 0),
    ).fetchone()
    if row:
        raise ApiError(409, f"מספר {number} כבר משויך לשחקן {row['name']}")


def insert_player(conn, team_id, name, position, number):
    ensure_number_free(conn, team_id, number)
    cur = conn.execute(
        "INSERT INTO players (team_id, name, position, number, created_at) VALUES (?,?,?,?,?)",
        (team_id, name, position, number, now_iso()),
    )
    return cur.lastrowid


# ---------------------------------------------------------------- domain: activities

def ingest_activity(conn, team_id, *, date_, kind, title, source, metrics, user_id=None,
                    notes="", import_batch_id=None):
    """The single write path for performance data.

    `metrics` is a list of dicts: player_id + distance_km/max_speed_kmh/sprints/minutes.
    CSV import, manual entry, demo seeding and any future device adapter all go
    through here, so provenance is always recorded the same way.
    """
    if source not in {"demo", "manual", "csv", "device"}:
        raise ValueError("unknown source")
    cur = conn.execute(
        """INSERT INTO activities (team_id, date, kind, title, source, import_batch_id, notes,
                                   created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
        (team_id, date_, kind, title, source, import_batch_id, notes, user_id, now_iso()),
    )
    activity_id = cur.lastrowid
    for m in metrics:
        conn.execute(
            """INSERT INTO activity_metrics (activity_id, player_id, distance_km, max_speed_kmh,
                                             sprints, minutes) VALUES (?,?,?,?,?,?)""",
            (activity_id, m["player_id"], m.get("distance_km"), m.get("max_speed_kmh"),
             m.get("sprints"), m.get("minutes")),
        )
    return activity_id


def list_activities(conn, team_id, date_from=None, date_to=None):
    sql = "SELECT * FROM activities WHERE team_id = ?"
    args = [team_id]
    if date_from:
        sql += " AND date >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        args.append(date_to)
    sql += " ORDER BY date DESC, id DESC"
    acts = [dict(r) for r in conn.execute(sql, args)]
    if not acts:
        return []
    by_id = {a["id"]: a for a in acts}
    for a in acts:
        a["metrics"] = []
    placeholders = ",".join("?" * len(by_id))
    for r in conn.execute(
        f"""SELECT activity_id, player_id, distance_km, max_speed_kmh, sprints, minutes
            FROM activity_metrics WHERE activity_id IN ({placeholders})""",
        list(by_id),
    ):
        by_id[r["activity_id"]]["metrics"].append(
            {k: r[k] for k in ("player_id", "distance_km", "max_speed_kmh", "sprints", "minutes")}
        )
    return acts


def activity_of_team(conn, team_id, activity_id):
    row = conn.execute(
        "SELECT * FROM activities WHERE id = ? AND team_id = ?", (activity_id, team_id)
    ).fetchone()
    if not row:
        raise ApiError(404, "הפעילות לא נמצאה")
    return row


# ---------------------------------------------------------------- CSV import / export

CSV_HEADER_ALIASES = {
    "date": "date", "תאריך": "date",
    "type": "type", "kind": "type", "סוג": "type",
    "title": "title", "session": "title", "כותרת": "title",
    "name": "name", "שם": "name",
    "position": "position", "עמדה": "position",
    "number": "number", "מספר": "number",
    "distance": "distance", "מרחק": "distance",
    "speed": "speed", "max_speed": "speed", "מהירות": "speed",
    "sprints": "sprints", "ספרינטים": "sprints",
    "minutes": "minutes", "דקות": "minutes",
    "source": "source", "מקור": "source",
}
CSV_REQUIRED = {"name", "distance", "speed", "minutes"}
EXPORT_HEADER = ["date", "type", "title", "source", "name", "position", "number",
                 "distance", "speed", "sprints", "minutes"]


def norm_name(name):
    return " ".join(name.split()).casefold()


def plan_csv_import(conn, team_id, text, default_date=None, default_kind=None,
                    create_missing_players=False):
    """Parse and validate a CSV. Returns a plan; never writes. Errors are per row."""
    if text.startswith("﻿"):
        text = text[1:]
    if not text.strip():
        raise bad_request("הקובץ ריק")
    try:
        sample = text[:4096]
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows = [r for r in reader if any(c.strip() for c in r)]
    if len(rows) < 2:
        raise bad_request("הקובץ חייב לכלול שורת כותרות ולפחות שורת נתונים אחת")
    header = [CSV_HEADER_ALIASES.get(h.strip().lower()) for h in rows[0]]
    missing = CSV_REQUIRED - set(header)
    if missing:
        raise bad_request("עמודות חסרות בקובץ: " + ", ".join(sorted(missing)),
                          {"expected": EXPORT_HEADER})
    if len(rows) - 1 > 2000:
        raise bad_request("עד 2,000 שורות בקובץ אחד")
    if "date" not in header and not default_date:
        raise bad_request("בקובץ אין עמודת date — יש לבחור תאריך לפעילות")
    if default_date:
        default_date = parse_date(default_date)
    default_kind = parse_kind(default_kind) or "training"

    players = [dict(r) for r in conn.execute(
        "SELECT * FROM players WHERE team_id = ? AND status = 'active'", (team_id,))]
    by_number = {p["number"]: p for p in players if p["number"] is not None}
    by_name = {}
    for p in players:
        by_name.setdefault(norm_name(p["name"]), []).append(p)

    errors, new_players, groups = [], {}, {}
    for line_no, raw in enumerate(rows[1:], start=2):
        rec = {}
        for key, cell in zip(header, raw):
            if key:
                rec[key] = cell.strip()
        try:
            name = clean_text(rec.get("name"), "name")
            d = parse_date(rec["date"]) if rec.get("date") else default_date
            if not d:
                raise bad_request("חסר תאריך")
            kind = parse_kind(rec.get("type")) if rec.get("type") else default_kind
            if not kind:
                raise bad_request("סוג פעילות לא מוכר (training/match או אימון/משחק)")
            title = clean_text(rec.get("title", ""), "title", required=False)
            number = parse_number(rec.get("number"))
            position = parse_position(rec.get("position")) if rec.get("position") else None
            if rec.get("position") and not position:
                raise bad_request("עמדה לא מוכרת (GK/DEF/MID/FWD או שוער/הגנה/קישור/התקפה)")
            metrics = parse_metrics({
                "distance_km": rec.get("distance"), "max_speed_kmh": rec.get("speed"),
                "sprints": rec.get("sprints"), "minutes": rec.get("minutes"),
            })
            if metrics is None:
                raise bad_request("אין ערכי ביצוע בשורה")

            # Resolve the player. Number is the stronger key; a name mismatch is an error.
            player_key = None
            if number is not None and number in by_number:
                p = by_number[number]
                if norm_name(p["name"]) != norm_name(name):
                    raise bad_request(f"מספר {number} משויך בסגל לשחקן {p['name']}, לא ל-{name}")
                player_key = ("id", p["id"])
            else:
                matches = by_name.get(norm_name(name), [])
                if len(matches) == 1:
                    if number is not None and matches[0]["number"] not in (None, number):
                        raise bad_request(f"{name} רשום בסגל עם מספר {matches[0]['number']}, בקובץ מופיע {number}")
                    player_key = ("id", matches[0]["id"])
                elif len(matches) > 1:
                    raise bad_request(f"יש בסגל יותר משחקן אחד בשם {name} — הוסף מספר חולצה")
            if player_key is None:
                if not create_missing_players:
                    raise bad_request(f"השחקן {name} לא נמצא בסגל")
                if not position:
                    raise bad_request(f"כדי ליצור את {name} כשחקן חדש נדרשת עמדה")
                nk = norm_name(name)
                if nk in new_players:
                    np_ = new_players[nk]
                    if np_["number"] != number:
                        raise bad_request(f"מספר חולצה לא עקבי עבור {name}")
                else:
                    if number is not None and any(x["number"] == number for x in new_players.values()):
                        raise bad_request(f"מספר {number} מופיע אצל שני שחקנים חדשים")
                    new_players[nk] = {"name": name, "position": position, "number": number}
                player_key = ("new", nk)

            gkey = (d, kind, title)
            group = groups.setdefault(gkey, {"date": d, "kind": kind, "title": title, "rows": {}})
            if player_key in group["rows"]:
                raise bad_request(f"{name} מופיע פעמיים באותה פעילות")
            group["rows"][player_key] = metrics
        except ApiError as e:
            errors.append({"line": line_no, "message": e.message})

    warnings = []
    for g in groups.values():
        dup = conn.execute(
            "SELECT 1 FROM activities WHERE team_id = ? AND date = ? AND kind = ? AND title = ?",
            (team_id, g["date"], g["kind"], g["title"]),
        ).fetchone()
        if dup:
            warnings.append(f"כבר קיימת פעילות בתאריך {g['date']} עם אותו סוג וכותרת — ייתכן ייבוא כפול")

    return {
        "errors": errors,
        "warnings": warnings,
        "new_players": list(new_players.values()),
        "activities": [
            {"date": g["date"], "kind": g["kind"], "title": g["title"], "players": len(g["rows"])}
            for g in sorted(groups.values(), key=lambda g: g["date"])
        ],
        "row_count": len(rows) - 1,
        "_groups": groups,
    }


def commit_csv_import(conn, team_id, plan, user_id, filename):
    new_ids = {}
    for p in plan["new_players"]:
        new_ids[norm_name(p["name"])] = insert_player(conn, team_id, p["name"], p["position"], p["number"])
    cur = conn.execute(
        """INSERT INTO import_batches (team_id, source, filename, row_count, created_by, created_at)
           VALUES (?,?,?,?,?,?)""",
        (team_id, "csv", filename, plan["row_count"], user_id, now_iso()),
    )
    batch_id = cur.lastrowid
    for g in plan["_groups"].values():
        metrics = []
        for (kind, ref), m in g["rows"].items():
            pid = ref if kind == "id" else new_ids[ref]
            metrics.append({"player_id": pid, **m})
        ingest_activity(conn, team_id, date_=g["date"], kind=g["kind"], title=g["title"],
                        source="csv", metrics=metrics, user_id=user_id, import_batch_id=batch_id)
    return batch_id


def fmt_num(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def export_csv(conn, team_id):
    players = {r["id"]: r for r in conn.execute("SELECT * FROM players WHERE team_id = ?", (team_id,))}
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(EXPORT_HEADER)
    for a in reversed(list_activities(conn, team_id)):
        for m in a["metrics"]:
            p = players[m["player_id"]]
            w.writerow([a["date"], a["kind"], a["title"], a["source"], p["name"], p["position"],
                        p["number"] or "", fmt_num(m["distance_km"]), fmt_num(m["max_speed_kmh"]),
                        fmt_num(m["sprints"]), fmt_num(m["minutes"])])
    return "﻿" + out.getvalue()


# ---------------------------------------------------------------- HTTP plumbing

ROUTES = []


def route(method, pattern, auth=True):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn, auth))
        return fn
    return deco


class Request:
    def __init__(self, handler, conn, user, params, query, body):
        self.handler = handler
        self.conn = conn
        self.user = user
        self.params = params
        self.query = query
        self.body = body
        self.set_cookie = None
        self.raw_response = None  # (content_type, bytes, extra_headers)

    def q(self, key):
        v = self.query.get(key)
        return v[0] if v else None

    @property
    def ip(self):
        return self.handler.client_address[0]


def require_owner(req):
    if req.user["role"] != "owner":
        raise ApiError(403, "פעולה זו זמינה למנהל הפלטפורמה בלבד")


def int_param(req, key):
    return int(req.params[key])


# ---------------------------------------------------------------- routes: auth

def user_public(conn, user):
    teams = []
    if user["role"] == "owner":
        rows = conn.execute("SELECT * FROM teams ORDER BY is_demo, name").fetchall()
    else:
        rows = conn.execute("SELECT * FROM teams WHERE id = ?", (user["team_id"],)).fetchall()
    teams = [team_dict(r) for r in rows]
    return {
        "user": {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"],
                 "team_id": user["team_id"], "must_change_password": bool(user["must_change_password"])},
        "teams": teams,
    }


@route("POST", r"/api/login", auth=False)
def login(req):
    email = str(req.body.get("email", "")).strip().lower()
    password = req.body.get("password", "")
    conn = req.conn
    since = (datetime.now(timezone.utc) - timedelta(minutes=LOGIN_WINDOW_MIN)).isoformat()
    by_email = conn.execute("SELECT COUNT(*) FROM login_failures WHERE email = ? AND at > ?",
                            (email, since)).fetchone()[0]
    by_ip = conn.execute("SELECT COUNT(*) FROM login_failures WHERE ip = ? AND at > ?",
                         (req.ip, since)).fetchone()[0]
    if by_email >= LOGIN_MAX_PER_EMAIL or by_ip >= LOGIN_MAX_PER_IP:
        raise ApiError(429, f"יותר מדי ניסיונות התחברות. נסה שוב בעוד {LOGIN_WINDOW_MIN} דקות.")
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    ok = user is not None and isinstance(password, str) and verify_password(password, user["password_hash"])
    if not ok or not user["active"]:
        conn.execute("INSERT INTO login_failures (email, ip, at) VALUES (?,?,?)", (email, req.ip, now_iso()))
        conn.commit()
        raise ApiError(401, "אימייל או סיסמה שגויים")
    conn.execute("DELETE FROM login_failures WHERE email = ?", (email,))
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_iso(),))
    conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_iso(), user["id"]))
    token = create_session(conn, user["id"])
    audit(conn, user["id"], user["team_id"], "login")
    conn.commit()
    req.set_cookie = token
    return user_public(conn, user)


@route("POST", r"/api/logout", auth=False)
def logout(req):
    token = req.handler.session_token()
    if token:
        req.conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        req.conn.commit()
    req.set_cookie = ""
    return {"ok": True}


@route("GET", r"/api/me")
def me(req):
    return user_public(req.conn, req.user)


@route("POST", r"/api/me/password")
def change_own_password(req):
    if not verify_password(str(req.body.get("current", "")), req.user["password_hash"]):
        raise ApiError(400, "הסיסמה הנוכחית שגויה")
    new = req.body.get("new")
    validate_new_password(new)
    conn = req.conn
    conn.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                 (hash_password(new), req.user["id"]))
    # Invalidate other sessions; keep the current one.
    current = token_hash(req.handler.session_token())
    conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (req.user["id"], current))
    audit(conn, req.user["id"], req.user["team_id"], "password.change")
    conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------- routes: platform admin

@route("GET", r"/api/admin/teams")
def admin_teams(req):
    require_owner(req)
    out = []
    for t in req.conn.execute("SELECT * FROM teams ORDER BY is_demo, name"):
        counts = req.conn.execute(
            """SELECT
                 (SELECT COUNT(*) FROM players WHERE team_id = :t AND status = 'active') AS players,
                 (SELECT COUNT(*) FROM activities WHERE team_id = :t) AS activities,
                 (SELECT MAX(date) FROM activities WHERE team_id = :t) AS last_activity,
                 (SELECT COUNT(*) FROM users WHERE team_id = :t AND active = 1) AS managers""",
            {"t": t["id"]},
        ).fetchone()
        out.append(team_dict(t, dict(counts)))
    return {"teams": out}


@route("POST", r"/api/admin/teams")
def admin_create_team(req):
    require_owner(req)
    name = clean_text(req.body.get("name"), "שם הקבוצה", 80)
    plan = req.body.get("plan") or "pilot"
    if plan not in PLANS:
        raise bad_request("מסלול לא תקין")
    cur = req.conn.execute("INSERT INTO teams (name, plan, created_at) VALUES (?,?,?)",
                           (name, plan, now_iso()))
    audit(req.conn, req.user["id"], cur.lastrowid, "team.create", name=name, plan=plan)
    req.conn.commit()
    return {"team": team_dict(team_row(req.conn, cur.lastrowid))}


@route("PATCH", r"/api/admin/teams/(?P<team_id>\d+)")
def admin_update_team(req):
    require_owner(req)
    tid = int_param(req, "team_id")
    team = team_row(req.conn, tid)
    changes = {}
    if "name" in req.body:
        changes["name"] = clean_text(req.body["name"], "שם הקבוצה", 80)
    if "plan" in req.body:
        if req.body["plan"] not in PLANS:
            raise bad_request("מסלול לא תקין")
        changes["plan"] = req.body["plan"]
    if "status" in req.body:
        if req.body["status"] not in TEAM_STATUSES:
            raise bad_request("סטטוס לא תקין")
        changes["status"] = req.body["status"]
    if not changes:
        raise bad_request("לא נשלחו שינויים")
    sets = ", ".join(f"{k} = ?" for k in changes)
    req.conn.execute(f"UPDATE teams SET {sets} WHERE id = ?", (*changes.values(), tid))
    if changes.get("status") == "suspended":
        req.conn.execute(
            "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE team_id = ?)", (tid,))
    audit(req.conn, req.user["id"], tid, "team.update", before=team_dict(team), changes=changes)
    req.conn.commit()
    return {"team": team_dict(team_row(req.conn, tid))}


def manager_dict(row):
    return {k: row[k] for k in ("id", "email", "name", "role", "team_id", "created_at", "last_login_at")} | {
        "active": bool(row["active"]), "must_change_password": bool(row["must_change_password"])}


@route("GET", r"/api/admin/users")
def admin_users(req):
    require_owner(req)
    rows = req.conn.execute("SELECT * FROM users ORDER BY role DESC, team_id, name").fetchall()
    return {"users": [manager_dict(r) for r in rows]}


@route("POST", r"/api/admin/users")
def admin_create_user(req):
    require_owner(req)
    email = clean_email(req.body.get("email"))
    name = clean_text(req.body.get("name"), "שם", 80)
    password = req.body.get("password")
    validate_new_password(password)
    try:
        team_id = int(req.body.get("team_id"))
    except (TypeError, ValueError):
        raise bad_request("יש לבחור קבוצה")
    team_row(req.conn, team_id)
    if req.conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        raise ApiError(409, "קיים כבר משתמש עם אימייל זה")
    cur = req.conn.execute(
        """INSERT INTO users (email, name, password_hash, role, team_id, must_change_password, created_at)
           VALUES (?,?,?,?,?,1,?)""",
        (email, name, hash_password(password), "manager", team_id, now_iso()),
    )
    audit(req.conn, req.user["id"], team_id, "user.create", email=email)
    req.conn.commit()
    row = req.conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"user": manager_dict(row)}


def managed_user(req):
    row = req.conn.execute("SELECT * FROM users WHERE id = ?", (int_param(req, "user_id"),)).fetchone()
    if not row:
        raise ApiError(404, "המשתמש לא נמצא")
    if row["role"] == "owner":
        raise ApiError(403, "לא ניתן לשנות את חשבון מנהל הפלטפורמה מכאן")
    return row


@route("PATCH", r"/api/admin/users/(?P<user_id>\d+)")
def admin_update_user(req):
    require_owner(req)
    row = managed_user(req)
    changes = {}
    if "name" in req.body:
        changes["name"] = clean_text(req.body["name"], "שם", 80)
    if "active" in req.body:
        changes["active"] = 1 if req.body["active"] else 0
    if "team_id" in req.body:
        changes["team_id"] = team_row(req.conn, int(req.body["team_id"]))["id"]
    if not changes:
        raise bad_request("לא נשלחו שינויים")
    sets = ", ".join(f"{k} = ?" for k in changes)
    req.conn.execute(f"UPDATE users SET {sets} WHERE id = ?", (*changes.values(), row["id"]))
    if changes.get("active") == 0 or "team_id" in changes:
        req.conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
    audit(req.conn, req.user["id"], row["team_id"], "user.update", user=row["email"], changes=changes)
    req.conn.commit()
    return {"user": manager_dict(req.conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone())}


@route("POST", r"/api/admin/users/(?P<user_id>\d+)/password")
def admin_reset_password(req):
    require_owner(req)
    row = managed_user(req)
    password = req.body.get("password")
    validate_new_password(password)
    req.conn.execute("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?",
                     (hash_password(password), row["id"]))
    req.conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
    audit(req.conn, req.user["id"], row["team_id"], "user.password_reset", user=row["email"])
    req.conn.commit()
    return {"ok": True}


@route("GET", r"/api/admin/audit")
def admin_audit(req):
    require_owner(req)
    limit = min(int(req.q("limit") or 200), 1000)
    rows = req.conn.execute(
        """SELECT a.*, u.email AS user_email, t.name AS team_name FROM audit_log a
           LEFT JOIN users u ON u.id = a.user_id LEFT JOIN teams t ON t.id = a.team_id
           ORDER BY a.id DESC LIMIT ?""", (limit,)).fetchall()
    return {"entries": [dict(r) | {"detail": json.loads(r["detail"])} for r in rows]}


# ---------------------------------------------------------------- routes: team data

T = r"/api/teams/(?P<team_id>\d+)"


def team_ctx(req):
    tid = int_param(req, "team_id")
    return require_team_access(req.conn, req.user, tid)


@route("GET", T)
def get_team(req):
    team = team_ctx(req)
    return {"team": team_dict(team)}


@route("GET", T + r"/data")
def get_team_data(req):
    """Everything the dashboard needs for one team and period, in one round trip."""
    team = team_ctx(req)
    date_from = parse_date(req.q("from"), "from") if req.q("from") else None
    date_to = parse_date(req.q("to"), "to") if req.q("to") else None
    players = [player_dict(r) for r in req.conn.execute(
        "SELECT * FROM players WHERE team_id = ? ORDER BY status, number IS NULL, number, name", (team["id"],))]
    return {
        "team": team_dict(team),
        "players": players,
        "activities": list_activities(req.conn, team["id"], date_from, date_to),
        "devices": list_devices(req.conn, team["id"]),
    }


@route("POST", T + r"/players")
def create_player(req):
    team = team_ctx(req)
    name = clean_text(req.body.get("name"), "שם השחקן", 80)
    position = parse_position(req.body.get("position"))
    if not position:
        raise bad_request("יש לבחור עמדה")
    number = parse_number(req.body.get("number"))
    pid = insert_player(req.conn, team["id"], name, position, number)
    audit(req.conn, req.user["id"], team["id"], "player.create", name=name, number=number)
    req.conn.commit()
    return {"player": player_dict(req.conn.execute("SELECT * FROM players WHERE id = ?", (pid,)).fetchone())}


@route("PATCH", T + r"/players/(?P<player_id>\d+)")
def update_player(req):
    team = team_ctx(req)
    pid = int_param(req, "player_id")
    row = req.conn.execute("SELECT * FROM players WHERE id = ? AND team_id = ?", (pid, team["id"])).fetchone()
    if not row:
        raise ApiError(404, "השחקן לא נמצא")
    changes = {}
    if "name" in req.body:
        changes["name"] = clean_text(req.body["name"], "שם השחקן", 80)
    if "position" in req.body:
        pos = parse_position(req.body["position"])
        if not pos:
            raise bad_request("עמדה לא תקינה")
        changes["position"] = pos
    if "number" in req.body:
        changes["number"] = parse_number(req.body["number"])
    if "status" in req.body:
        if req.body["status"] not in ("active", "archived"):
            raise bad_request("סטטוס לא תקין")
        changes["status"] = req.body["status"]
    if not changes:
        raise bad_request("לא נשלחו שינויים")
    final_status = changes.get("status", row["status"])
    final_number = changes.get("number", row["number"])
    if final_status == "active":
        ensure_number_free(req.conn, team["id"], final_number, pid)
    if changes.get("status") == "archived":
        req.conn.execute(
            "UPDATE device_assignments SET released_at = ? WHERE player_id = ? AND released_at IS NULL",
            (now_iso(), pid))
    sets = ", ".join(f"{k} = ?" for k in changes)
    req.conn.execute(f"UPDATE players SET {sets} WHERE id = ?", (*changes.values(), pid))
    audit(req.conn, req.user["id"], team["id"], "player.update", player=row["name"], changes=changes)
    req.conn.commit()
    return {"player": player_dict(req.conn.execute("SELECT * FROM players WHERE id = ?", (pid,)).fetchone())}


@route("POST", T + r"/activities")
def create_activity(req):
    team = team_ctx(req)
    b = req.body
    d = parse_date(b.get("date"))
    kind = parse_kind(b.get("kind"))
    if not kind:
        raise bad_request("יש לבחור סוג פעילות")
    title = clean_text(b.get("title", ""), "כותרת", 120, required=False)
    notes = clean_text(b.get("notes", ""), "הערות", 1000, required=False)
    entries = b.get("metrics")
    if not isinstance(entries, list) or not entries:
        raise bad_request("יש להזין נתונים לפחות לשחקן אחד")
    active = {r["id"] for r in req.conn.execute(
        "SELECT id FROM players WHERE team_id = ? AND status = 'active'", (team["id"],))}
    metrics, seen = [], set()
    for e in entries:
        try:
            pid = int(e.get("player_id"))
        except (TypeError, ValueError, AttributeError):
            raise bad_request("שחקן לא תקין")
        if pid not in active:
            raise bad_request("שחקן לא שייך לסגל הפעיל של הקבוצה")
        if pid in seen:
            raise bad_request("שחקן מופיע פעמיים")
        seen.add(pid)
        m = parse_metrics(e)
        if m:
            metrics.append({"player_id": pid, **m})
    if not metrics:
        raise bad_request("יש להזין נתונים לפחות לשחקן אחד")
    aid = ingest_activity(req.conn, team["id"], date_=d, kind=kind, title=title, source="manual",
                          metrics=metrics, user_id=req.user["id"], notes=notes)
    audit(req.conn, req.user["id"], team["id"], "activity.create", activity_id=aid, date=d, players=len(metrics))
    req.conn.commit()
    return {"activity_id": aid}


@route("PATCH", T + r"/activities/(?P<activity_id>\d+)")
def update_activity(req):
    team = team_ctx(req)
    act = activity_of_team(req.conn, team["id"], int_param(req, "activity_id"))
    changes = {}
    if "date" in req.body:
        changes["date"] = parse_date(req.body["date"])
    if "kind" in req.body:
        k = parse_kind(req.body["kind"])
        if not k:
            raise bad_request("סוג פעילות לא תקין")
        changes["kind"] = k
    if "title" in req.body:
        changes["title"] = clean_text(req.body["title"], "כותרת", 120, required=False)
    if "notes" in req.body:
        changes["notes"] = clean_text(req.body["notes"], "הערות", 1000, required=False)
    if not changes:
        raise bad_request("לא נשלחו שינויים")
    sets = ", ".join(f"{k} = ?" for k in changes)
    req.conn.execute(f"UPDATE activities SET {sets} WHERE id = ?", (*changes.values(), act["id"]))
    audit(req.conn, req.user["id"], team["id"], "activity.update", activity_id=act["id"], changes=changes)
    req.conn.commit()
    return {"ok": True}


@route("DELETE", T + r"/activities/(?P<activity_id>\d+)")
def delete_activity(req):
    team = team_ctx(req)
    act = activity_of_team(req.conn, team["id"], int_param(req, "activity_id"))
    req.conn.execute("DELETE FROM activities WHERE id = ?", (act["id"],))
    audit(req.conn, req.user["id"], team["id"], "activity.delete", activity_id=act["id"],
          date=act["date"], source=act["source"])
    req.conn.commit()
    return {"ok": True}


@route("POST", T + r"/import/csv")
def import_csv(req):
    team = team_ctx(req)
    text = req.body.get("csv")
    if not isinstance(text, str):
        raise bad_request("לא התקבל תוכן קובץ")
    filename = clean_text(req.body.get("filename", ""), "שם קובץ", 200, required=False)
    plan = plan_csv_import(req.conn, team["id"], text, req.body.get("default_date"),
                           req.body.get("default_kind"), bool(req.body.get("create_missing_players")))
    public = {k: v for k, v in plan.items() if not k.startswith("_")}
    if req.body.get("dry_run") or plan["errors"]:
        return public | {"committed": False}
    try:
        batch_id = commit_csv_import(req.conn, team["id"], plan, req.user["id"], filename)
    except ApiError:
        req.conn.rollback()
        raise
    audit(req.conn, req.user["id"], team["id"], "import.csv", batch_id=batch_id, filename=filename,
          rows=plan["row_count"], activities=len(plan["activities"]), new_players=len(plan["new_players"]))
    req.conn.commit()
    return public | {"committed": True, "batch_id": batch_id}


@route("GET", T + r"/imports")
def list_imports(req):
    team = team_ctx(req)
    rows = req.conn.execute(
        """SELECT b.*, u.name AS created_by_name,
                  (SELECT COUNT(*) FROM activities a WHERE a.import_batch_id = b.id) AS activities
           FROM import_batches b LEFT JOIN users u ON u.id = b.created_by
           WHERE b.team_id = ? ORDER BY b.id DESC""", (team["id"],)).fetchall()
    return {"imports": [dict(r) for r in rows]}


@route("DELETE", T + r"/imports/(?P<batch_id>\d+)")
def undo_import(req):
    team = team_ctx(req)
    bid = int_param(req, "batch_id")
    row = req.conn.execute("SELECT * FROM import_batches WHERE id = ? AND team_id = ?",
                           (bid, team["id"])).fetchone()
    if not row:
        raise ApiError(404, "הייבוא לא נמצא")
    req.conn.execute("DELETE FROM import_batches WHERE id = ?", (bid,))  # cascades to activities/metrics
    audit(req.conn, req.user["id"], team["id"], "import.undo", batch_id=bid, filename=row["filename"])
    req.conn.commit()
    return {"ok": True}


@route("GET", T + r"/export\.csv")
def export_team_csv(req):
    team = team_ctx(req)
    body = export_csv(req.conn, team["id"]).encode("utf-8")
    fname = f"anox-team-{team['id']}-{date.today().isoformat()}.csv"
    req.raw_response = ("text/csv; charset=utf-8", body,
                        {"Content-Disposition": f'attachment; filename="{fname}"'})
    return None


# ---------------------------------------------------------------- routes: devices (registry only)

def list_devices(conn, team_id):
    rows = conn.execute(
        """SELECT d.*, a.player_id, a.assigned_at FROM devices d
           LEFT JOIN device_assignments a ON a.device_id = d.id AND a.released_at IS NULL
           WHERE d.team_id = ? ORDER BY d.status, d.label""", (team_id,)).fetchall()
    return [dict(r) for r in rows]


@route("POST", T + r"/devices")
def create_device(req):
    team = team_ctx(req)
    label = clean_text(req.body.get("label"), "תווית", 40)
    serial = clean_text(req.body.get("serial", ""), "מספר סידורי", 80, required=False) or None
    cur = req.conn.execute(
        "INSERT INTO devices (team_id, label, serial, model, created_at) VALUES (?,?,?,?,?)",
        (team["id"], label, serial, "AT01", now_iso()))
    audit(req.conn, req.user["id"], team["id"], "device.create", label=label, serial=serial)
    req.conn.commit()
    return {"device_id": cur.lastrowid}


@route("POST", T + r"/devices/(?P<device_id>\d+)/assign")
def assign_device(req):
    """Assign a device to a player (or release it with player_id = null).
    One open assignment per device and per player; history is kept."""
    team = team_ctx(req)
    did = int_param(req, "device_id")
    dev = req.conn.execute("SELECT * FROM devices WHERE id = ? AND team_id = ?", (did, team["id"])).fetchone()
    if not dev:
        raise ApiError(404, "המכשיר לא נמצא")
    pid = req.body.get("player_id")
    ts = now_iso()
    req.conn.execute("UPDATE device_assignments SET released_at = ? WHERE device_id = ? AND released_at IS NULL",
                     (ts, did))
    if pid is not None:
        player = req.conn.execute("SELECT * FROM players WHERE id = ? AND team_id = ? AND status = 'active'",
                                  (int(pid), team["id"])).fetchone()
        if not player:
            req.conn.rollback()
            raise bad_request("שחקן לא תקין")
        req.conn.execute("UPDATE device_assignments SET released_at = ? WHERE player_id = ? AND released_at IS NULL",
                         (ts, player["id"]))
        req.conn.execute("INSERT INTO device_assignments (device_id, player_id, assigned_at) VALUES (?,?,?)",
                         (did, player["id"], ts))
    audit(req.conn, req.user["id"], team["id"], "device.assign", device=dev["label"], player_id=pid)
    req.conn.commit()
    return {"devices": list_devices(req.conn, team["id"])}


# ---------------------------------------------------------------- request handler

class Handler(BaseHTTPRequestHandler):
    server_version = "ANOX"
    sys_version = ""

    def log_message(self, fmt, *args):
        if os.environ.get("ANOX_QUIET") != "1":
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def session_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        c = SimpleCookie()
        try:
            c.load(raw)
        except Exception:
            return None
        return c[COOKIE_NAME].value if COOKIE_NAME in c else None

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )

    def send_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            parts = [f"{COOKIE_NAME}={cookie}", "Path=/", "HttpOnly", "SameSite=Strict"]
            if COOKIE_SECURE:
                parts.append("Secure")
            parts.append(f"Max-Age={SESSION_HOURS * 3600 if cookie else 0}")
            self.send_header("Set-Cookie", "; ".join(parts))
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path):
        entry = STATIC_FILES.get(path)
        if not entry:
            self.send_json(404, {"error": "not found"})
            return
        fname, ctype = entry
        try:
            with open(os.path.join(ROOT, fname), "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_json(404, {"error": "not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def handle_api(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        for m, rx, fn, needs_auth in ROUTES:
            if m != method:
                continue
            match = rx.match(path)
            if match:
                break
        else:
            self.send_json(404, {"error": "נתיב לא נמצא"})
            return

        if method != "GET" and self.headers.get("X-ANOX-Request") != "1":
            # Cross-site forms cannot set custom headers; combined with SameSite=Strict this blocks CSRF.
            self.send_json(403, {"error": "בקשה נדחתה"})
            return

        body = {}
        if method in ("POST", "PATCH", "DELETE"):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self.send_json(413, {"error": "הבקשה גדולה מדי (עד 2MB)"})
                return
            if length:
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    self.send_json(400, {"error": "JSON לא תקין"})
                    return
                if not isinstance(body, dict):
                    self.send_json(400, {"error": "JSON לא תקין"})
                    return

        conn = connect()
        try:
            user = None
            if needs_auth:
                user = session_user(conn, self.session_token())
                if not user:
                    self.send_json(401, {"error": "נדרשת התחברות"})
                    return
            req = Request(self, conn, user, match.groupdict(), parse_qs(parsed.query), body)
            try:
                result = fn(req)
            except ApiError as e:
                conn.rollback()
                payload = {"error": e.message}
                if e.details:
                    payload["details"] = e.details
                self.send_json(e.status, payload)
                return
            except sqlite3.IntegrityError:
                conn.rollback()
                self.send_json(409, {"error": "הפעולה מתנגשת בנתונים קיימים"})
                return
            if req.raw_response:
                ctype, data, headers = req.raw_response
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_security_headers()
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_json(200, result, cookie=req.set_cookie)
        except Exception:
            conn.rollback()
            import traceback
            traceback.print_exc()
            self.send_json(500, {"error": "שגיאת שרת"})
        finally:
            conn.close()

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.handle_api("GET")
        else:
            self.serve_static(urlparse(self.path).path)

    def do_POST(self):
        self.handle_api("POST")

    def do_PATCH(self):
        self.handle_api("PATCH")

    def do_DELETE(self):
        self.handle_api("DELETE")


# ---------------------------------------------------------------- CLI

def create_owner(email, name, password, path=None):
    validate_new_password(password)
    email = clean_email(email)
    conn = connect(path)
    try:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise SystemExit("משתמש עם אימייל זה כבר קיים")
        conn.execute(
            "INSERT INTO users (email, name, password_hash, role, team_id, created_at) VALUES (?,?,?,?,NULL,?)",
            (email, name, hash_password(password), "owner", now_iso()))
        audit(conn, None, None, "owner.create", email=email)
        conn.commit()
    finally:
        conn.close()


def seed_demo(path=None):
    """Create demo teams with generated data. Every activity is tagged source='demo'
    and every team is flagged is_demo=1 so it can never be mistaken for real data."""
    import random
    rnd = random.Random(7)
    conn = connect(path)
    try:
        if conn.execute("SELECT 1 FROM teams WHERE is_demo = 1").fetchone():
            print("נתוני הדגמה כבר קיימים")
            return
        names = [
            ["עומר לוי", "GK"], ["איתי כהן", "DEF"], ["נועם פרץ", "DEF"], ["יונתן מזרחי", "DEF"],
            ["אורי ביטון", "DEF"], ["דניאל אברהם", "MID"], ["רועי שפירא", "MID"], ["אלון דהן", "MID"],
            ["תומר גבאי", "MID"], ["ליאור חדד", "FWD"], ["עידו אזולאי", "FWD"], ["שחר מלכה", "FWD"],
        ]
        for team_name in ("קבוצת הדגמה א׳ — נוער", "קבוצת הדגמה ב׳ — ילדים"):
            cur = conn.execute("INSERT INTO teams (name, plan, is_demo, created_at) VALUES (?,?,1,?)",
                               (team_name, "trial", now_iso()))
            tid = cur.lastrowid
            pids = [(insert_player(conn, tid, n, p, i + 1), p) for i, (n, p) in enumerate(names)]
            start = date.today() - timedelta(days=41)
            for day in range(42):
                d = start + timedelta(days=day)
                if d.weekday() not in (0, 2, 3, 5):
                    continue
                kind = "match" if d.weekday() == 5 else "training"
                metrics = []
                for pid, pos in pids:
                    base = {"GK": 4.5, "DEF": 8.6, "MID": 9.8, "FWD": 8.9}[pos] * (1.15 if kind == "match" else 0.72)
                    minutes = 90 if kind == "match" else rnd.choice([70, 75, 80])
                    metrics.append({
                        "player_id": pid,
                        "distance_km": round(base * rnd.uniform(0.85, 1.12), 2),
                        "max_speed_kmh": round((24 if pos == "GK" else 29) * rnd.uniform(0.9, 1.08), 1),
                        "sprints": None if pos == "GK" else rnd.randint(6, 28 if kind == "match" else 16),
                        "minutes": minutes,
                    })
                ingest_activity(conn, tid, date_=d.isoformat(), kind=kind,
                                title="משחק ליגה" if kind == "match" else "אימון קבוצתי",
                                source="demo", metrics=metrics)
        audit(conn, None, None, "demo.seed")
        conn.commit()
        print("נוספו 2 קבוצות הדגמה (מסומנות כהדגמה)")
    finally:
        conn.close()


def main(argv):
    init_db()
    if len(argv) > 1 and argv[1] == "create-owner":
        email = os.environ.get("ANOX_OWNER_EMAIL") or input("אימייל: ").strip()
        name = os.environ.get("ANOX_OWNER_NAME") or input("שם: ").strip() or "מנהל הפלטפורמה"
        password = os.environ.get("ANOX_OWNER_PASSWORD") or getpass.getpass("סיסמה (10 תווים לפחות): ")
        try:
            create_owner(email, name, password)
        except ApiError as e:
            raise SystemExit(e.message)
        print("חשבון מנהל הפלטפורמה נוצר")
        return
    if len(argv) > 1 and argv[1] == "seed-demo":
        seed_demo()
        return
    conn = connect()
    has_owner = conn.execute("SELECT 1 FROM users WHERE role = 'owner'").fetchone()
    conn.close()
    if not has_owner:
        print("אין עדיין חשבון מנהל פלטפורמה. הרץ: python3 server.py create-owner", file=sys.stderr)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ANOX פועל בכתובת http://{HOST}:{PORT}  (DB: {DB_PATH})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main(sys.argv)
