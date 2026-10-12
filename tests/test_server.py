"""Server tests. Run: python3 -m unittest discover -s tests"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date, timedelta
from http.cookiejar import CookieJar

TMP = tempfile.mkdtemp()
os.environ["ANOX_DB"] = os.path.join(TMP, "test.sqlite3")
os.environ["ANOX_PBKDF2_ITERATIONS"] = "1000"
os.environ["ANOX_QUIET"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

OWNER = ("owner@anox.test", "owner-password-1")
TODAY = date.today().isoformat()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, method, path, body=None, csrf=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if csrf:
            req.add_header("X-ANOX-Request", "1")
        try:
            with self.opener.open(req) as r:
                raw = r.read().decode("utf-8")
                return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def ok(self, method, path, body=None):
        status, payload = self.call(method, path, body)
        assert status == 200, (status, payload)
        return payload

    def login(self, email, password):
        return self.call("POST", "/api/login", {"email": email, "password": password})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        server.create_owner(OWNER[0], "בעלים", OWNER[1])
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        conn = server.connect()
        conn.execute("DELETE FROM login_failures")
        conn.commit()
        conn.close()
        self.owner = Client(self.base)
        self.assertEqual(self.owner.login(*OWNER)[0], 200)

    # helpers
    def make_team(self, name):
        return self.owner.ok("POST", "/api/admin/teams", {"name": name})["team"]["id"]

    def make_manager(self, team_id, email):
        self.owner.ok("POST", "/api/admin/users", {
            "email": email, "name": "מנהל", "password": "manager-pass-1", "team_id": team_id})
        c = Client(self.base)
        self.assertEqual(c.login(email, "manager-pass-1")[0], 200)
        return c

    def add_player(self, client, tid, name, pos="MID", number=None):
        return client.ok("POST", f"/api/teams/{tid}/players",
                         {"name": name, "position": pos, "number": number})["player"]["id"]

    # tests
    def test_requires_login(self):
        status, _ = Client(self.base).call("GET", "/api/me")
        self.assertEqual(status, 401)

    def test_csrf_header_required_for_writes(self):
        status, _ = self.owner.call("POST", "/api/admin/teams", {"name": "x"}, csrf=False)
        self.assertEqual(status, 403)

    def test_static_whitelist_does_not_expose_db(self):
        status, _ = Client(self.base).call("GET", "/.local/anox.sqlite3")
        self.assertEqual(status, 404)
        status, _ = Client(self.base).call("GET", "/server.py")
        self.assertEqual(status, 404)

    def test_team_isolation(self):
        a, b = self.make_team("קבוצה א"), self.make_team("קבוצה ב")
        ma = self.make_manager(a, "a@anox.test")
        pid_b = self.add_player(self.owner, b, "שחקן ב", number=9)
        self.owner.ok("POST", f"/api/teams/{b}/activities", {
            "date": TODAY, "kind": "training", "metrics": [{"player_id": pid_b, "distance_km": 6}]})

        me = ma.ok("GET", "/api/me")
        self.assertEqual([t["id"] for t in me["teams"]], [a])
        for method, path, body in [
            ("GET", f"/api/teams/{b}/data", None),
            ("POST", f"/api/teams/{b}/players", {"name": "x", "position": "GK"}),
            ("PATCH", f"/api/teams/{b}/players/{pid_b}", {"name": "x"}),
            ("GET", f"/api/teams/{b}/export.csv", None),
            ("POST", f"/api/teams/{b}/import/csv", {"csv": "name,distance,speed,minutes\nx,1,1,1", "default_date": TODAY}),
        ]:
            status, _ = ma.call(method, path, body)
            self.assertEqual(status, 404, path)
        # A player id from team B cannot be used inside team A either.
        status, _ = ma.call("PATCH", f"/api/teams/{a}/players/{pid_b}", {"name": "x"})
        self.assertEqual(status, 404)
        status, _ = ma.call("POST", f"/api/teams/{a}/activities", {
            "date": TODAY, "kind": "training", "metrics": [{"player_id": pid_b, "distance_km": 5}]})
        self.assertEqual(status, 400)
        # Managers cannot use admin endpoints.
        self.assertEqual(ma.call("GET", "/api/admin/teams")[0], 403)
        self.assertEqual(ma.call("POST", "/api/admin/teams", {"name": "x"})[0], 403)

    def test_suspended_team_blocks_manager_not_owner(self):
        t = self.make_team("מושעית")
        m = self.make_manager(t, "s@anox.test")
        self.owner.ok("PATCH", f"/api/admin/teams/{t}", {"status": "suspended"})
        # Suspending clears the manager's sessions.
        self.assertEqual(m.call("GET", f"/api/teams/{t}/data")[0], 401)
        m.login("s@anox.test", "manager-pass-1")
        self.assertEqual(m.call("GET", f"/api/teams/{t}/data")[0], 403)
        self.owner.ok("GET", f"/api/teams/{t}/data")
        self.owner.ok("PATCH", f"/api/admin/teams/{t}", {"status": "active"})
        m.ok("GET", f"/api/teams/{t}/data")

    def test_deactivated_manager_cannot_login(self):
        t = self.make_team("ת")
        m = self.make_manager(t, "d@anox.test")
        uid = m.ok("GET", "/api/me")["user"]["id"]
        self.owner.ok("PATCH", f"/api/admin/users/{uid}", {"active": False})
        self.assertEqual(m.call("GET", "/api/me")[0], 401)
        self.assertEqual(m.login("d@anox.test", "manager-pass-1")[0], 401)

    def test_password_change_and_reset(self):
        t = self.make_team("סיסמאות")
        m = self.make_manager(t, "p@anox.test")
        me = m.ok("GET", "/api/me")
        self.assertTrue(me["user"]["must_change_password"])
        self.assertEqual(m.call("POST", "/api/me/password", {"current": "wrong", "new": "x" * 12})[0], 400)
        self.assertEqual(m.call("POST", "/api/me/password", {"current": "manager-pass-1", "new": "short"})[0], 400)
        m.ok("POST", "/api/me/password", {"current": "manager-pass-1", "new": "new-password-22"})
        self.assertFalse(m.ok("GET", "/api/me")["user"]["must_change_password"])
        self.owner.ok("POST", f"/api/admin/users/{me['user']['id']}/password", {"password": "reset-password-3"})
        self.assertEqual(m.call("GET", "/api/me")[0], 401)
        self.assertEqual(Client(self.base).login("p@anox.test", "reset-password-3")[0], 200)

    def test_login_rate_limit(self):
        c = Client(self.base)
        for _ in range(server.LOGIN_MAX_PER_EMAIL):
            self.assertEqual(c.login("rl@anox.test", "nope")[0], 401)
        self.assertEqual(c.login("rl@anox.test", "nope")[0], 429)

    def test_manual_activity_history_and_validation(self):
        t = self.make_team("היסטוריה")
        p1 = self.add_player(self.owner, t, "א", number=1)
        p2 = self.add_player(self.owner, t, "ב", number=2)
        self.owner.ok("POST", f"/api/teams/{t}/activities", {
            "date": YESTERDAY, "kind": "match", "title": "ליגה",
            "metrics": [{"player_id": p1, "distance_km": 9.5, "max_speed_kmh": 30.1, "sprints": 12, "minutes": 90},
                        {"player_id": p2, "distance_km": "", "max_speed_kmh": "", "minutes": ""}]})
        self.owner.ok("POST", f"/api/teams/{t}/activities", {
            "date": TODAY, "kind": "training",
            "metrics": [{"player_id": p1, "distance_km": 6}, {"player_id": p2, "distance_km": 5.5}]})
        data = self.owner.ok("GET", f"/api/teams/{t}/data")
        self.assertEqual([a["date"] for a in data["activities"]], [TODAY, YESTERDAY])
        self.assertTrue(all(a["source"] == "manual" for a in data["activities"]))
        self.assertEqual(len(data["activities"][1]["metrics"]), 1)  # empty row skipped
        self.assertIsNone(data["activities"][0]["metrics"][0]["sprints"])
        ranged = self.owner.ok("GET", f"/api/teams/{t}/data?from={TODAY}")
        self.assertEqual(len(ranged["activities"]), 1)
        # Out-of-range values and future dates are rejected.
        future = (date.today() + timedelta(days=5)).isoformat()
        for bad in [{"date": TODAY, "kind": "training", "metrics": [{"player_id": p1, "max_speed_kmh": 80}]},
                    {"date": future, "kind": "training", "metrics": [{"player_id": p1, "distance_km": 5}]},
                    {"date": TODAY, "kind": "x", "metrics": [{"player_id": p1, "distance_km": 5}]},
                    {"date": TODAY, "kind": "training", "source": "device", "metrics": []}]:
            self.assertEqual(self.owner.call("POST", f"/api/teams/{t}/activities", bad)[0], 400)
        # Client cannot spoof the source.
        self.owner.ok("POST", f"/api/teams/{t}/activities", {
            "date": TODAY, "kind": "training", "source": "device",
            "metrics": [{"player_id": p1, "distance_km": 4}]})
        sources = {a["source"] for a in self.owner.ok("GET", f"/api/teams/{t}/data")["activities"]}
        self.assertEqual(sources, {"manual"})

    def test_player_number_unique_and_archive(self):
        t = self.make_team("מספרים")
        p1 = self.add_player(self.owner, t, "א", number=7)
        self.assertEqual(self.owner.call("POST", f"/api/teams/{t}/players",
                                         {"name": "ב", "position": "FWD", "number": 7})[0], 409)
        self.owner.ok("PATCH", f"/api/teams/{t}/players/{p1}", {"status": "archived"})
        self.add_player(self.owner, t, "ב", "FWD", 7)  # number is free once archived
        self.assertEqual(self.owner.call("PATCH", f"/api/teams/{t}/players/{p1}", {"status": "active"})[0], 409)

    def test_csv_import_dry_run_commit_undo(self):
        t = self.make_team("ייבוא")
        self.add_player(self.owner, t, "דני כהן", "MID", 8)
        csv_text = (
            "﻿date,type,title,name,position,number,distance,speed,sprints,minutes\n"
            f"{YESTERDAY},משחק,ליגה,דני כהן,MID,8,10.2,31.5,18,90\n"
            f"{YESTERDAY},משחק,ליגה,יוסי חדש,FWD,9,9.1,32,20,85\n"
            f"{TODAY},training,,דני כהן,,8,6.1,27,,70\n"
        )
        url = f"/api/teams/{t}/import/csv"
        # Without permission to create players the new name is an error and nothing is written.
        r = self.owner.ok("POST", url, {"csv": csv_text})
        self.assertFalse(r["committed"])
        self.assertEqual(r["errors"][0]["line"], 3)
        r = self.owner.ok("POST", url, {"csv": csv_text, "create_missing_players": True, "dry_run": True})
        self.assertFalse(r["committed"])
        self.assertEqual(r["errors"], [])
        self.assertEqual(len(r["activities"]), 2)
        self.assertEqual([p["name"] for p in r["new_players"]], ["יוסי חדש"])
        self.assertEqual(self.owner.ok("GET", f"/api/teams/{t}/data")["activities"], [])
        r = self.owner.ok("POST", url, {"csv": csv_text, "create_missing_players": True, "filename": "a.csv"})
        self.assertTrue(r["committed"])
        data = self.owner.ok("GET", f"/api/teams/{t}/data")
        self.assertEqual(len(data["activities"]), 2)
        self.assertEqual({a["source"] for a in data["activities"]}, {"csv"})
        self.assertEqual(len(data["players"]), 2)
        # Re-importing warns about duplicates.
        r = self.owner.ok("POST", url, {"csv": csv_text, "create_missing_players": True, "dry_run": True})
        self.assertTrue(r["warnings"])
        # Export round-trips the history.
        status, exported = self.owner.call("GET", f"/api/teams/{t}/export.csv")
        self.assertEqual(status, 200)
        self.assertIn("יוסי חדש", exported)
        self.assertIn(",csv,", exported)
        # Undo removes the batch's activities but keeps players.
        batches = self.owner.ok("GET", f"/api/teams/{t}/imports")["imports"]
        self.assertEqual(batches[0]["activities"], 2)
        self.owner.ok("DELETE", f"/api/teams/{t}/imports/{batches[0]['id']}")
        self.assertEqual(self.owner.ok("GET", f"/api/teams/{t}/data")["activities"], [])

    def test_csv_legacy_roster_format_and_errors(self):
        t = self.make_team("פורמט ישן")
        legacy = "name,position,number,distance,speed,sprints,minutes\nרון,DEF,4,8.4,29.3,11,88\n"
        r = self.owner.call("POST", f"/api/teams/{t}/import/csv", {"csv": legacy, "create_missing_players": True})
        self.assertEqual(r[0], 400)  # needs a date when the file has none
        r = self.owner.ok("POST", f"/api/teams/{t}/import/csv", {
            "csv": legacy, "create_missing_players": True, "default_date": TODAY, "default_kind": "match"})
        self.assertTrue(r["committed"])
        bad = ("name,number,distance,speed,minutes\n"
               "רון,5,8,29,90\n"          # name/number mismatch with roster
               "אחר,4,8,29,90\n"          # number 4 belongs to רון
               "רון,,abc,29,90\n")        # non-numeric
        r = self.owner.ok("POST", f"/api/teams/{t}/import/csv", {"csv": bad, "default_date": TODAY})
        self.assertFalse(r["committed"])
        self.assertEqual([e["line"] for e in r["errors"]], [2, 3, 4])
        self.assertEqual(self.owner.call("POST", f"/api/teams/{t}/import/csv",
                                         {"csv": "a,b\n1,2", "default_date": TODAY})[0], 400)

    def test_device_registry_one_player_per_device(self):
        t = self.make_team("מכשירים")
        p1 = self.add_player(self.owner, t, "א", number=1)
        p2 = self.add_player(self.owner, t, "ב", number=2)
        d1 = self.owner.ok("POST", f"/api/teams/{t}/devices", {"label": "AT01-1"})["device_id"]
        d2 = self.owner.ok("POST", f"/api/teams/{t}/devices", {"label": "AT01-2"})["device_id"]
        self.owner.ok("POST", f"/api/teams/{t}/devices/{d1}/assign", {"player_id": p1})
        devs = self.owner.ok("POST", f"/api/teams/{t}/devices/{d2}/assign", {"player_id": p1})["devices"]
        by_id = {d["id"]: d for d in devs}
        self.assertIsNone(by_id[d1]["player_id"])  # p1 moved to d2
        self.assertEqual(by_id[d2]["player_id"], p1)
        devs = self.owner.ok("POST", f"/api/teams/{t}/devices/{d2}/assign", {"player_id": p2})["devices"]
        self.assertEqual({d["id"]: d["player_id"] for d in devs}[d2], p2)

    def test_persistence_across_restart(self):
        t = self.make_team("קבע")
        self.add_player(self.owner, t, "נשמר", number=3)
        server.init_db()  # idempotent re-init, as on restart
        conn = server.connect()
        self.assertEqual(conn.execute("SELECT name FROM players WHERE team_id = ?", (t,)).fetchone()[0], "נשמר")
        conn.close()

    def test_audit_log_records_actions(self):
        t = self.make_team("יומן")
        entries = self.owner.ok("GET", "/api/admin/audit")["entries"]
        self.assertTrue(any(e["action"] == "team.create" and e["team_id"] == t for e in entries))

    def test_seed_demo_is_flagged(self):
        server.seed_demo()
        teams = self.owner.ok("GET", "/api/admin/teams")["teams"]
        demo = [x for x in teams if x["is_demo"]]
        self.assertEqual(len(demo), 2)
        data = self.owner.ok("GET", f"/api/teams/{demo[0]['id']}/data")
        self.assertEqual({a["source"] for a in data["activities"]}, {"demo"})

    def test_logout(self):
        self.owner.ok("POST", "/api/logout")
        self.assertEqual(self.owner.call("GET", "/api/me")[0], 401)


if __name__ == "__main__":
    unittest.main()
