import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import release as r  # noqa: E402


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def seq(statuses):
    it = iter(statuses)
    last = {"v": None}

    def get():
        try:
            last["v"] = next(it)
        except StopIteration:
            pass
        return {"id": "dep-1", "status": last["v"]}
    return get


class PollDeploy(unittest.TestCase):
    def test_goes_live(self):
        c = FakeClock()
        seen = []
        out = r.poll_deploy(seq(["created", "build_in_progress", "pre_deploy_in_progress", "update_in_progress", "live"]),
                            sleep=c.sleep, now=c.now, timeout=100, interval=5, on_status=seen.append)
        self.assertEqual(out["status"], "live")
        self.assertEqual(seen, ["created", "build_in_progress", "pre_deploy_in_progress", "update_in_progress", "live"])
        self.assertEqual(c.sleeps, [5, 5, 5, 5])

    def test_repeated_status_reported_once(self):
        c = FakeClock()
        seen = []
        r.poll_deploy(seq(["build_in_progress"] * 3 + ["live"]), sleep=c.sleep, now=c.now, timeout=100, interval=1, on_status=seen.append)
        self.assertEqual(seen, ["build_in_progress", "live"])

    def test_failure_statuses_raise(self):
        for bad in ("build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"):
            with self.subTest(bad):
                c = FakeClock()
                with self.assertRaises(r.DeployFailed) as cm:
                    r.poll_deploy(seq(["created", bad]), sleep=c.sleep, now=c.now, timeout=100, interval=1)
                self.assertEqual(cm.exception.deploy["status"], bad)

    def test_timeout(self):
        c = FakeClock()
        with self.assertRaises(r.DeployTimeout):
            r.poll_deploy(seq(["build_in_progress"]), sleep=c.sleep, now=c.now, timeout=30, interval=10)


class MigrationLogs(unittest.TestCase):
    def test_applied(self):
        lines = ["Datasource db", "The following migration(s) have been applied:", "All migrations have been successfully applied."]
        self.assertEqual(r.check_migration_logs(lines)[0], "applied")

    def test_noop(self):
        self.assertEqual(r.check_migration_logs(["3 migrations found", "No pending migrations to apply."])[0], "noop")

    def test_missing(self):
        self.assertEqual(r.check_migration_logs(["Build successful", "Starting service"]), ("missing", ""))

    def test_failure_beats_success_text(self):
        v, ev = r.check_migration_logs(["Error: P3009 migrate found failed migrations", "All migrations have been successfully applied"])
        self.assertEqual(v, "failed")
        self.assertIn("P3009", ev)

    def test_case_insensitive_success(self):
        self.assertEqual(r.check_migration_logs(["ALL MIGRATIONS HAVE BEEN SUCCESSFULLY APPLIED"])[0], "applied")


class Tags(unittest.TestCase):
    def test_latest_orders_numerically(self):
        tags = ["release-2026-11-05-9", "release-2026-11-05-10", "release-2026-10-30-3", "v1", "release-bad"]
        self.assertEqual(r.latest_release_tag(tags), "release-2026-11-05-10")

    def test_latest_none(self):
        self.assertIsNone(r.latest_release_tag(["v1", "foo"]))

    def test_next_tag(self):
        self.assertEqual(r.next_tag_name([], "2026-11-06"), "release-2026-11-06-1")
        self.assertEqual(r.next_tag_name(["release-2026-11-06-1", "release-2026-11-06-2", "release-2026-11-05-7"], "2026-11-06"),
                         "release-2026-11-06-3")


class Selection(unittest.TestCase):
    OPTS = ["a.js", "b.js", "c.js"]

    def test_default_and_none_and_all(self):
        self.assertEqual(r.parse_selection("", self.OPTS, ["b.js"]), ["b.js"])
        self.assertEqual(r.parse_selection("none", self.OPTS, ["b.js"]), [])
        self.assertEqual(r.parse_selection("all", self.OPTS, ["b.js"]), self.OPTS)

    def test_numbers(self):
        self.assertEqual(r.parse_selection("3, 1 3", self.OPTS, []), ["c.js", "a.js"])

    def test_bad(self):
        for bad in ("4", "x", "0,1"):
            with self.assertRaises(ValueError):
                r.parse_selection(bad, self.OPTS, [])

    def test_globs(self):
        self.assertEqual(r.match_globs(["x.js", "y.css", "z.liquid"], ["*.js", "*.css"]), ["x.js", "y.css"])


class Themes(unittest.TestCase):
    def test_parse_with_noise_and_live_flag(self):
        raw = 'Some banner\n[{"id": 1, "name": "Dsg", "role": "live"}, {"id": 2, "name": "Review copy", "role": "unpublished"}]\n'
        t = r.parse_themes(raw)
        self.assertEqual([x["live"] for x in t], [True, False])
        self.assertEqual(t[1]["id"], "2")

    def test_main_role_is_live(self):
        self.assertTrue(r.parse_themes('[{"id": 5, "name": "x", "role": "main"}]')[0]["live"])

    def test_no_json(self):
        with self.assertRaises(ValueError):
            r.parse_themes("not logged in")


class Masking(unittest.TestCase):
    def test_masks_known_and_pattern_tokens(self):
        m = r.Masker(["supersecretvalue123"])
        out = m("key=supersecretvalue123 rnd_ABCDEFGH12345678 shpat_abcdef123456 Authorization: Bearer abc.def-ghi_jkl123 api_key: hunter2hunter2")
        for leak in ("supersecretvalue123", "rnd_ABCDEFGH", "shpat_abcdef", "abc.def-ghi", "hunter2hunter2"):
            self.assertNotIn(leak, out)

    def test_leaves_normal_text(self):
        self.assertEqual(r.Masker([])("deploy dep-1 is live"), "deploy dep-1 is live")


class FakeHttp:
    """Scripted responses keyed by (method, url fragment). A list value is consumed in order."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        for (m, frag), resp in self.routes:
            if m == method and frag in url:
                if isinstance(resp, list):
                    return resp.pop(0) if len(resp) > 1 else resp[0]
                return resp
        return 404, "{}"


class RenderClientTests(unittest.TestCase):
    def client(self, routes):
        http = FakeHttp(routes)
        return r.RenderClient("rnd_testkey12345678", "https://api.example/v1", http=http, sleep=lambda s: None), http

    def test_find_service_exact_name(self):
        body = json.dumps([
            {"service": {"id": "srv-2", "name": "dsg-quotes-web-old", "ownerId": "o"}},
            {"service": {"id": "srv-1", "name": "dsg-quotes-web", "ownerId": "tea-1", "serviceDetails": {"url": "https://w.onrender.com"}}},
        ])
        c, http = self.client([(("GET", "/services?name=dsg-quotes-web"), (200, body))])
        s = c.find_service("dsg-quotes-web")
        self.assertEqual((s["id"], s["ownerId"], s["url"]), ("srv-1", "tea-1", "https://w.onrender.com"))
        self.assertEqual(http.calls[0][2]["Authorization"], "Bearer rnd_testkey12345678")

    def test_find_service_missing(self):
        c, _ = self.client([(("GET", "/services"), (200, "[]"))])
        with self.assertRaises(r.ReleaseError):
            c.find_service("nope")

    def test_trigger_sends_commit(self):
        c, http = self.client([(("POST", "/services/srv-1/deploys"), (201, '{"id": "dep-9"}'))])
        self.assertEqual(c.trigger_deploy("srv-1", "abc123"), "dep-9")
        self.assertEqual(json.loads(http.calls[0][3])["commitId"], "abc123")

    def test_retries_on_429_then_succeeds(self):
        c, http = self.client([(("GET", "/services/s/deploys/d"), [(429, "slow down"), (200, '{"status": "live"}')])])
        self.assertEqual(c.get_deploy("s", "d")["status"], "live")
        self.assertEqual(len(http.calls), 2)

    def test_http_error_message_has_no_key(self):
        c, _ = self.client([(("GET", "/services"), (401, "unauthorized"))])
        with self.assertRaises(r.ReleaseError) as cm:
            c.find_service("x")
        self.assertIn("401", str(cm.exception))
        self.assertNotIn("rnd_testkey", str(cm.exception))

    def test_fetch_logs_pages(self):
        p1 = json.dumps({"logs": [{"message": "a"}, {"message": "b"}], "hasMore": True, "nextStartTime": "T2", "nextEndTime": "T9"})
        p2 = json.dumps({"logs": [{"message": "c"}], "hasMore": False})
        c, http = self.client([(("GET", "/logs"), [(200, p1), (200, p2)])])
        self.assertEqual(c.fetch_logs("o", "s", "T0", "T9"), ["a", "b", "c"])
        self.assertIn("startTime=T2", http.calls[1][1])

    def test_deploy_logs_window_and_migration_flow(self):
        logs = json.dumps({"logs": [{"message": "Applying migration 20261105000000_shared_quotes"},
                                    {"message": "All migrations have been successfully applied."}], "hasMore": False})
        c, http = self.client([(("GET", "/logs"), (200, logs))])
        svc = {"id": "srv-1", "ownerId": "tea-1"}
        dep = {"createdAt": "2026-11-06T12:00:00.123456789Z", "finishedAt": "2026-11-06T12:04:00Z"}
        verdict, _ = r.check_migration_logs(c.deploy_logs(svc, dep))
        self.assertEqual(verdict, "applied")
        url = http.calls[0][1]
        self.assertIn("ownerId=tea-1", url)
        self.assertIn("resource=srv-1", url)
        self.assertIn("startTime=2026-11-06T11%3A59%3A55", url)


if __name__ == "__main__":
    unittest.main()
