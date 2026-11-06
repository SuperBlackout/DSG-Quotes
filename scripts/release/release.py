#!/usr/bin/env python3
"""DSG Quotes guided release (Python 3.10+, standard library only).

Normally started through `pnpm release` (scripts/release/release.ps1). See README.md.

Steps, in order: preflight, render, shopify, theme, smoke, tag.
Every step that changes something asks y/n first (unless --yes). --dry-run changes nothing.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
STEPS = ["preflight", "render", "shopify", "theme", "smoke", "tag"]

DEPLOY_OK = {"live"}
DEPLOY_FAILED = {"build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"}


class ReleaseError(Exception):
    """A step failed in a way that must stop the release."""


class DeployFailed(ReleaseError):
    def __init__(self, deploy: dict):
        self.deploy = deploy
        super().__init__(f"deploy {deploy.get('id', '?')} ended as '{deploy.get('status')}'")


class DeployTimeout(ReleaseError):
    pass


# --------------------------------------------------------------------------- masking / logging

_TOKEN_PATTERNS = [
    re.compile(r"\brnd_[A-Za-z0-9]{8,}"),            # Render API keys
    re.compile(r"\bshp(?:at|ca|ss|pa|tka)_[A-Za-z0-9]{8,}"),  # Shopify tokens
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s\"',;]{6,}"),
]


class Masker:
    def __init__(self, secrets: Iterable[str] = ()):
        self.secrets = sorted({s for s in secrets if s and len(s) >= 6}, key=len, reverse=True)

    def __call__(self, text: str) -> str:
        for s in self.secrets:
            text = text.replace(s, "***")
        for pat in _TOKEN_PATTERNS:
            if pat.groups:
                text = pat.sub(lambda m: m.group(1) + "***", text)
            else:
                text = pat.sub("***", text)
        return text


class Log:
    """Prints and writes every line through the masker."""

    def __init__(self, masker: Masker, path: Path | None):
        self.mask = masker
        self.path = path
        self._fh = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(path, "a", encoding="utf-8")

    def line(self, text: str = "") -> None:
        safe = self.mask(text)
        try:
            print(safe, flush=True)
        except UnicodeEncodeError:
            print(safe.encode("ascii", "replace").decode("ascii"), flush=True)
        if self._fh:
            self._fh.write(f"{datetime.now().isoformat(timespec='seconds')} {safe}\n")
            self._fh.flush()

    def step(self, name: str) -> None:
        self.line("")
        self.line(f"=== {name} " + "=" * max(3, 60 - len(name)))

    def close(self) -> None:
        if self._fh:
            self._fh.close()


# --------------------------------------------------------------------------- pure helpers (unit-tested)

def poll_deploy(
    get_deploy: Callable[[], dict],
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    timeout: float = 1200,
    interval: float = 10,
    on_status: Callable[[str], None] | None = None,
) -> dict:
    """Polls until the deploy is live. Raises DeployFailed on a failing status, DeployTimeout when too slow."""
    start = now()
    last = None
    while True:
        deploy = get_deploy()
        status = deploy.get("status", "")
        if status != last:
            last = status
            if on_status:
                on_status(status)
        if status in DEPLOY_OK:
            return deploy
        if status in DEPLOY_FAILED:
            raise DeployFailed(deploy)
        if now() - start > timeout:
            raise DeployTimeout(f"deploy {deploy.get('id', '?')} still '{status}' after {int(timeout)}s")
        sleep(interval)


def check_migration_logs(
    messages: Iterable[str],
    success: str = "All migrations have been successfully applied",
    noop: str = "No pending migrations to apply",
    failures: Iterable[str] = ("Migration failed to apply", "P3009", "P3018"),
) -> tuple[str, str]:
    """Returns (verdict, evidence). verdict: 'applied' | 'noop' | 'failed' | 'missing'.

    prisma migrate deploy prints "All migrations have been successfully applied" when it applied
    something and "No pending migrations to apply." when the database was already current.
    """
    msgs = list(messages)
    for m in msgs:
        for f in failures:
            if f in m:
                return "failed", m.strip()
    for m in msgs:
        if success.lower() in m.lower():
            return "applied", m.strip()
    for m in msgs:
        if noop.lower() in m.lower():
            return "noop", m.strip()
    return "missing", ""


_TAG_RE = re.compile(r"^release-(\d{4})-(\d{2})-(\d{2})-(\d+)$")


def _tag_key(tag: str):
    m = _TAG_RE.match(tag)
    return tuple(int(x) for x in m.groups()) if m else None


def latest_release_tag(tags: Iterable[str]) -> str | None:
    keyed = [(k, t) for t in tags if (k := _tag_key(t.strip()))]
    return max(keyed)[1] if keyed else None


def next_tag_name(tags: Iterable[str], today: str) -> str:
    """today is YYYY-MM-DD. Returns release-YYYY-MM-DD-N with N one above any existing tag for that day."""
    prefix = f"release-{today}-"
    nums = [int(t[len(prefix):]) for t in tags if t.startswith(prefix) and t[len(prefix):].isdigit()]
    return f"{prefix}{max(nums, default=0) + 1}"


def match_globs(names: Iterable[str], globs: Iterable[str]) -> list[str]:
    globs = list(globs)
    return sorted(n for n in names if any(fnmatch.fnmatch(n, g) for g in globs))


def parse_selection(text: str, options: list[str], default: list[str]) -> list[str]:
    """'' -> default, 'none' -> [], 'all' -> everything, else comma separated 1-based numbers."""
    t = text.strip().lower()
    if t == "":
        return list(default)
    if t in ("none", "n", "0"):
        return []
    if t in ("all", "a"):
        return list(options)
    picked: list[str] = []
    for part in re.split(r"[,\s]+", t):
        if not part:
            continue
        if not part.isdigit() or not (1 <= int(part) <= len(options)):
            raise ValueError(f"'{part}' is not a number from 1 to {len(options)}")
        name = options[int(part) - 1]
        if name not in picked:
            picked.append(name)
    return picked


def parse_themes(raw: str) -> list[dict]:
    """Parses `shopify theme list --json`. Returns [{'id','name','role','live'}]."""
    start = raw.find("[")
    end = raw.rfind("]")
    if start < 0 or end < start:
        raise ValueError("no JSON array in `shopify theme list --json` output")
    data = json.loads(raw[start:end + 1])
    themes = []
    for t in data:
        role = str(t.get("role", "")).lower()
        themes.append({"id": str(t["id"]), "name": t.get("name", ""), "role": role, "live": role in ("live", "main")})
    return themes


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse_iso(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    if "." in s:
        head, rest = s.split(".", 1)
        frac = re.match(r"\d+", rest).group(0)[:6]
        tail = rest[len(re.match(r"\d+", rest).group(0)):]
        s = f"{head}.{frac}{tail}"
    return datetime.fromisoformat(s)


# --------------------------------------------------------------------------- Render API

HttpFn = Callable[[str, str, dict, bytes | None], tuple[int, str]]


def _urllib_http(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, str]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


class RenderClient:
    def __init__(self, api_key: str, base: str, http: HttpFn = _urllib_http, sleep: Callable[[float], None] = time.sleep):
        self.key = api_key
        self.base = base.rstrip("/")
        self.http = http
        self.sleep = sleep

    def request(self, method: str, path: str, params: list[tuple[str, str]] | None = None, body: dict | None = None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Authorization": f"Bearer {self.key}", "Accept": "application/json", "Content-Type": "application/json"}
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            status, text = self.http(method, url, headers, data)
            if status in (429, 500, 502, 503, 504) and attempt < 3:
                self.sleep(2 ** attempt)
                continue
            break
        if status >= 400:
            raise ReleaseError(f"Render API {method} {path} -> HTTP {status}: {text[:300]}")
        return json.loads(text) if text.strip() else {}

    def find_service(self, name: str) -> dict:
        """Looks a service up by exact name. Returns {'id','ownerId','url','name'}."""
        res = self.request("GET", "/services", [("name", name), ("limit", "20")])
        matches = [r.get("service", r) for r in res if (r.get("service", r)).get("name") == name]
        if not matches:
            raise ReleaseError(f"Render service '{name}' not found (check the name in release.config.json and the API key's workspace)")
        if len(matches) > 1:
            raise ReleaseError(f"More than one Render service is named '{name}'")
        s = matches[0]
        return {"id": s["id"], "ownerId": s.get("ownerId", ""), "name": name, "url": (s.get("serviceDetails") or {}).get("url", "")}

    def trigger_deploy(self, service_id: str, commit_id: str | None = None) -> str:
        body: dict = {"clearCache": "do_not_clear"}
        if commit_id:
            body["commitId"] = commit_id
        res = self.request("POST", f"/services/{service_id}/deploys", body=body)
        if "id" not in res:
            raise ReleaseError(f"Render did not return a deploy id: {str(res)[:200]}")
        return res["id"]

    def get_deploy(self, service_id: str, deploy_id: str) -> dict:
        return self.request("GET", f"/services/{service_id}/deploys/{deploy_id}")

    def fetch_logs(self, owner_id: str, service_id: str, start: str, end: str, max_pages: int = 10) -> list[str]:
        """All log messages for the service in [start, end], oldest first."""
        out: list[str] = []
        cur_start, cur_end = start, end
        for _ in range(max_pages):
            res = self.request("GET", "/logs", [
                ("ownerId", owner_id), ("resource", service_id), ("startTime", cur_start),
                ("endTime", cur_end), ("direction", "forward"), ("limit", "100"),
            ])
            out.extend(l.get("message", "") for l in res.get("logs", []))
            if not res.get("hasMore"):
                break
            cur_start, cur_end = res.get("nextStartTime", cur_start), res.get("nextEndTime", cur_end)
        return out

    def deploy_logs(self, service: dict, deploy: dict) -> list[str]:
        created = _parse_iso(deploy["createdAt"]) - timedelta(seconds=5)
        finished = _parse_iso(deploy["finishedAt"]) if deploy.get("finishedAt") else datetime.now(timezone.utc)
        return self.fetch_logs(service["ownerId"], service["id"], _iso(created), _iso(finished + timedelta(seconds=60)))


# --------------------------------------------------------------------------- context / process helpers

class Ctx:
    def __init__(self, args, config: dict, log: Log, root: Path = REPO_ROOT):
        self.args, self.cfg, self.log, self.root = args, config, log, root
        self.dry = args.dry_run
        self.assume_yes = args.yes
        self.summary: list[str] = []
        self.render: RenderClient | None = None
        self.services: dict[str, dict] = {}
        self.sha = ""

    def confirm(self, question: str, force_prompt: bool = False) -> bool:
        """y/n. In --dry-run nothing runs, so it answers no after describing it."""
        if self.dry:
            self.log.line(f"[dry-run] would ask: {question}")
            return False
        if self.assume_yes and not force_prompt:
            self.log.line(f"{question} [y/N] y (--yes)")
            return True
        try:
            ans = input(f"{question} [y/N] ")
        except EOFError:
            ans = ""
        self.log.line(f"{question} [y/N] {ans.strip() or 'n'}")
        return ans.strip().lower() in ("y", "yes")

    def ask(self, prompt: str) -> str:
        try:
            ans = input(prompt)
        except EOFError:
            ans = ""
        self.log.line(f"{prompt}{ans}")
        return ans

    def exe(self, name: str) -> str:
        found = shutil.which(name)
        if not found:
            raise ReleaseError(f"'{name}' was not found on PATH")
        return found

    def run(self, args: list[str], cwd: Path | None = None, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
        shown = " ".join(args)
        self.log.line(f"$ {shown}")
        env = {k: v for k, v in os.environ.items() if k != "RENDER_API_KEY"}
        exe = self.exe(args[0])
        proc = subprocess.Popen([exe, *args[1:]], cwd=str(cwd or self.root), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, env=env, text=True, encoding="utf-8", errors="replace")
        lines: list[str] = []
        assert proc.stdout is not None
        for ln in proc.stdout:
            ln = ln.rstrip("\r\n")
            lines.append(ln)
            if not capture:
                self.log.line("  " + ln)
        rc = proc.wait()
        if rc != 0 and capture:
            for ln in lines[-20:]:
                self.log.line("  " + ln)
        if check and rc != 0:
            raise ReleaseError(f"command failed (exit {rc}): {shown}")
        return subprocess.CompletedProcess(args, rc, "\n".join(lines), "")

    def git(self, *args: str) -> str:
        return self.run(["git", *args], capture=True).stdout.strip()

    def wanted(self, step: str) -> bool:
        if self.args.only and step not in self.args.only:
            return False
        return step not in self.args.skip


# --------------------------------------------------------------------------- steps

def step_preflight(ctx: Ctx) -> None:
    ctx.log.step("1. Preflight")
    db_pkgs = ctx.cfg["dbSuitePackages"]
    has_db = bool(os.environ.get("TEST_DATABASE_URL"))
    test_cmd = ["pnpm", "-r", "--if-present"]
    if not has_db:
        test_cmd += [a for p in db_pkgs for a in ("--filter", f"!{p}")]
    test_cmd.append("test")
    if ctx.dry:
        ctx.log.line("[dry-run] would check: on branch main, clean tree, equal to origin/main")
        ctx.log.line("[dry-run] would run: pnpm install --frozen-lockfile")
        ctx.log.line("[dry-run] would run: " + " ".join(test_cmd))
        ctx.log.line("[dry-run] would run: pnpm -F api graphql:validate (needs SHOPIFY_SCHEMA_PATH)")
        return
    branch = ctx.git("rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise ReleaseError(f"git is on '{branch}', not main. Switch to main first.")
    if ctx.git("status", "--porcelain"):
        raise ReleaseError("working tree is not clean. Commit or stash your changes first.")
    ctx.run(["git", "fetch", "origin", "main", "--quiet"])
    head = ctx.git("rev-parse", "HEAD")
    remote = ctx.git("rev-parse", "origin/main")
    if head != remote:
        counts = ctx.git("rev-list", "--left-right", "--count", "HEAD...origin/main").split()
        raise ReleaseError(f"main is not up to date with origin/main (ahead {counts[0]}, behind {counts[1]}). Pull or push first.")
    ctx.sha = head
    schema = os.environ.get("SHOPIFY_SCHEMA_PATH", "").strip()
    if not schema or not Path(schema).is_file():
        raise ReleaseError("SHOPIFY_SCHEMA_PATH must point to the downloaded Admin GraphQL schema file "
                           "(needed by `pnpm -F api graphql:validate`; see apps/api/README.md). Set it and re-run.")
    ctx.log.line(f"On main at {head[:10]}, clean, matches origin/main.")
    if not ctx.confirm("Run pnpm install --frozen-lockfile (updates node_modules)?"):
        raise ReleaseError("preflight declined; the release stops here.")
    ctx.run(["pnpm", "install", "--frozen-lockfile"])
    if has_db:
        ctx.log.line("TEST_DATABASE_URL is set: running ALL suites. The API suite wipes that database.")
    else:
        ctx.log.line("TEST_DATABASE_URL is not set: SKIPPING suites that need a database: " + ", ".join(db_pkgs))
    ctx.run(test_cmd)
    ctx.run(["pnpm", "-F", "api", "graphql:validate"])
    ctx.summary.append("preflight: ok" + ("" if has_db else " (database suites skipped)"))


def _render_client(ctx: Ctx) -> RenderClient:
    if ctx.render is None:
        key = os.environ.get("RENDER_API_KEY", "").strip()
        if not key:
            raise ReleaseError("RENDER_API_KEY is not set. Create one in Render > Account Settings > API Keys and set it in this shell.")
        ctx.render = RenderClient(key, ctx.cfg["renderApiBase"])
    return ctx.render


def _service(ctx: Ctx, role: str) -> dict:
    if role not in ctx.services:
        ctx.services[role] = _render_client(ctx).find_service(ctx.cfg["services"][role])
    return ctx.services[role]


def _deploy_and_wait(ctx: Ctx, role: str) -> tuple[dict, dict]:
    client = _render_client(ctx)
    svc = _service(ctx, role)
    commit = ctx.sha or None
    deploy_id = client.trigger_deploy(svc["id"], commit)
    ctx.log.line(f"Triggered deploy {deploy_id} for {svc['name']}" + (f" at {commit[:10]}" if commit else ""))
    try:
        deploy = poll_deploy(
            lambda: client.get_deploy(svc["id"], deploy_id),
            timeout=ctx.cfg["deployTimeoutSeconds"], interval=ctx.cfg["pollIntervalSeconds"],
            on_status=lambda s: ctx.log.line(f"  {svc['name']}: {s}"),
        )
    except DeployFailed as e:
        ctx.log.line(f"{svc['name']} deploy failed ({e.deploy.get('status')}). Last log lines:")
        try:
            for ln in client.deploy_logs(svc, e.deploy)[-40:]:
                ctx.log.line("  | " + ln)
        except ReleaseError as le:
            ctx.log.line(f"  (could not fetch logs: {le})")
        raise
    ctx.log.line(f"{svc['name']} is live.")
    return svc, deploy


def step_render(ctx: Ctx) -> None:
    ctx.log.step("2. Render deploys")
    names = ctx.cfg["services"]
    if ctx.dry:
        ctx.log.line(f"[dry-run] would look up services by name via the Render API (RENDER_API_KEY from env)")
        ctx.log.line(f"[dry-run] would deploy {names['web']}, wait for live, check logs for '{ctx.cfg['migrationSuccessPhrase']}'")
        ctx.log.line(f"[dry-run] would then deploy {names['admin']}, then optionally {names['worker']}")
        return
    _render_client(ctx)
    if not ctx.confirm(f"Deploy {names['web']} (runs prisma migrate deploy first)?"):
        ctx.log.line("Web deploy declined. Skipping all Render deploys: admin depends on the web migration.")
        ctx.summary.append("render: skipped")
        return
    svc, deploy = _deploy_and_wait(ctx, "web")
    verdict, evidence = _check_web_migrations(ctx, svc, deploy)
    if verdict in ("failed", "missing"):
        raise ReleaseError(f"migration check {verdict}; NOT deploying {names['admin']}. "
                           f"Expected '{ctx.cfg['migrationSuccessPhrase']}' in the {names['web']} deploy logs." + (f" Saw: {evidence}" if evidence else ""))
    ctx.log.line("Migrations: " + ("applied (" + evidence + ")" if verdict == "applied" else "none pending (" + evidence + ")"))
    ctx.summary.append(f"render: {names['web']} live, migrations {verdict}")
    if ctx.confirm(f"Deploy {names['admin']}?"):
        _deploy_and_wait(ctx, "admin")
        ctx.summary.append(f"render: {names['admin']} live")
    if ctx.confirm(f"Deploy {names['worker']} (optional)?"):
        _deploy_and_wait(ctx, "worker")
        ctx.summary.append(f"render: {names['worker']} live")


def _check_web_migrations(ctx: Ctx, svc: dict, deploy: dict) -> tuple[str, str]:
    client = _render_client(ctx)
    verdict, evidence = "missing", ""
    for attempt in range(4):  # logs can lag the deploy by a few seconds
        msgs = client.deploy_logs(svc, deploy)
        verdict, evidence = check_migration_logs(
            msgs, ctx.cfg["migrationSuccessPhrase"], ctx.cfg["migrationNoopPhrase"], ctx.cfg["migrationFailurePhrases"])
        if verdict != "missing":
            break
        time.sleep(5)
    return verdict, evidence


def step_shopify(ctx: Ctx) -> None:
    ctx.log.step("3. Shopify app deploy")
    if ctx.dry:
        ctx.log.line("[dry-run] would require shopify.app.toml, then run: shopify app deploy")
        return
    if not (ctx.root / "shopify.app.toml").exists():
        raise ReleaseError("shopify.app.toml is missing. Run `shopify app config link` in the repo root, then re-run `pnpm release --only shopify`.")
    if not ctx.confirm("Run `shopify app deploy` (ships the customer-account extensions and app config)?"):
        ctx.summary.append("shopify app: skipped")
        return
    ctx.run(["shopify", "app", "deploy"])
    ctx.summary.append("shopify app: deployed")


def changed_theme_assets(ctx: Ctx) -> tuple[list[str], list[str], str | None]:
    """Returns (candidates, default_selection, base_tag)."""
    t = ctx.cfg["theme"]
    adir = t["assetsDir"]
    tags = ctx.git("tag", "--list", "release-*").split()
    base = latest_release_tag(tags)
    if base:
        changed = ctx.git("diff", "--name-only", base, "HEAD", "--", adir).splitlines()
        names = [Path(p).name for p in changed if (ctx.root / p).exists()]
        files = match_globs(names, t["globs"])
        return files, files, base
    present = [p.name for p in (ctx.root / adir).iterdir() if p.is_file()]
    files = match_globs(present, t["globs"])
    default = [f for f in t["defaultSelection"] if f in files]
    return files, default, None


def step_theme(ctx: Ctx) -> None:
    ctx.log.step("4. Storefront theme assets")
    t = ctx.cfg["theme"]
    if ctx.dry:
        ctx.log.line(f"[dry-run] would list {t['assetsDir']} files changed since the latest release-* tag "
                     f"(no tag yet: all known assets, default {', '.join(t['defaultSelection'])})")
        ctx.log.line("[dry-run] would let you pick files and a theme, then run: shopify theme push --only assets/<file> --nodelete from a temp folder")
        return
    files, default, base = changed_theme_assets(ctx)
    if base:
        ctx.log.line(f"Theme assets changed since {base}:" if files else f"No theme assets changed since {base}.")
    else:
        ctx.log.line("No release-* tag yet. Known theme assets (nothing is assumed changed):")
    if not files:
        ctx.summary.append("theme: nothing to push")
        return
    for i, f in enumerate(files, 1):
        ctx.log.line(f"  {i}. {f}" + ("   [default]" if f in default else ""))
    if ctx.assume_yes:
        chosen = default
        ctx.log.line("--yes: using the default selection: " + (", ".join(chosen) or "none"))
    else:
        while True:
            try:
                chosen = parse_selection(ctx.ask("Files to push (numbers, 'all', 'none', Enter = default): "), files, default)
                break
            except ValueError as e:
                ctx.log.line(str(e))
    if not chosen:
        ctx.summary.append("theme: nothing selected")
        return

    store = t.get("store", "")
    store_args = ["--store", store] if store else []
    themes = _list_themes(ctx, store_args)
    if themes:
        for i, th in enumerate(themes, 1):
            ctx.log.line(f"  {i}. {th['name']} (id {th['id']}, {th['role'] or 'unpublished'})" + ("   << LIVE" if th["live"] else ""))
        pick = ctx.ask("Theme to push to (number): ").strip()
        if not pick.isdigit() or not (1 <= int(pick) <= len(themes)):
            raise ReleaseError("no theme chosen; theme push cancelled.")
        theme = themes[int(pick) - 1]
    else:
        tid = ctx.ask("Could not list themes. Enter a theme id (blank cancels): ").strip()
        if not tid:
            raise ReleaseError("no theme chosen; theme push cancelled.")
        theme = {"id": tid, "name": tid, "live": False}

    allow_live = False
    if theme["live"]:
        ctx.log.line(f"WARNING: '{theme['name']}' is the LIVE storefront theme.")
        if ctx.ask("Type PUSH TO LIVE to push to the live theme (anything else cancels): ").strip() != "PUSH TO LIVE":
            raise ReleaseError("live push not confirmed; theme push cancelled.")
        allow_live = True
    if not ctx.confirm(f"Push {len(chosen)} file(s) to theme '{theme['name']}' ({theme['id']})?", force_prompt=allow_live):
        ctx.summary.append("theme: skipped")
        return

    with tempfile.TemporaryDirectory(prefix="dsg-theme-") as tmp:
        tmpdir = Path(tmp)
        for d in ("assets", "config", "layout", "locales", "sections", "snippets", "templates"):
            (tmpdir / d).mkdir()
        for f in chosen:
            shutil.copy2(ctx.root / t["assetsDir"] / f, tmpdir / "assets" / f)
        cmd = ["shopify", "theme", "push", "--path", str(tmpdir), "--theme", theme["id"], "--nodelete", *store_args]
        for f in chosen:
            cmd += ["--only", f"assets/{f}"]
        if allow_live:
            cmd.append("--allow-live")
        ctx.run(cmd)
    ctx.summary.append(f"theme: pushed {', '.join(chosen)} to '{theme['name']}'")


def _list_themes(ctx: Ctx, store_args: list[str]) -> list[dict]:
    res = ctx.run(["shopify", "theme", "list", "--json", *store_args], check=False, capture=True)
    if res.returncode != 0:
        return []
    try:
        return parse_themes(res.stdout)
    except (ValueError, KeyError, json.JSONDecodeError):
        return []


def step_smoke(ctx: Ctx) -> None:
    ctx.log.step("5. Smoke test")
    path = ctx.cfg["healthPath"]
    if ctx.dry:
        ctx.log.line(f"[dry-run] would GET {path} on the web and admin services")
        return
    failures = []
    for role in ("web", "admin"):
        base = ""
        if os.environ.get("RENDER_API_KEY"):
            try:
                base = _service(ctx, role).get("url", "")
            except ReleaseError as e:
                ctx.log.line(f"  {role}: Render lookup failed ({e}); using fallback URL")
        base = base or ctx.cfg["fallbackHealthUrls"][role]
        url = base.rstrip("/") + path
        try:
            code, body = _urllib_http("GET", url, {"User-Agent": "dsg-release-tool"}, None)
        except Exception as e:  # network errors
            code, body = 0, str(e)
        ok = 200 <= code < 300
        ctx.log.line(f"  {role}: GET {url} -> {code or 'ERROR'} {'OK' if ok else 'FAIL'} {body[:80].strip()}")
        if not ok:
            failures.append(role)
    if failures:
        raise ReleaseError("health check failed for: " + ", ".join(failures))
    ctx.summary.append("smoke: web and admin healthy")


def step_tag(ctx: Ctx) -> None:
    ctx.log.step("6. Tag")
    if ctx.dry:
        ctx.log.line("[dry-run] would create local tag release-YYYY-MM-DD-N, then ask before pushing it")
        return
    tags = ctx.git("tag", "--list", "release-*").split()
    name = next_tag_name(tags, datetime.now().strftime("%Y-%m-%d"))
    if not ctx.confirm(f"Create local tag {name} on {ctx.git('rev-parse', '--short', 'HEAD')}?"):
        ctx.summary.append("tag: skipped")
        return
    ctx.run(["git", "tag", "-a", name, "-m", f"Release {name}"])
    ctx.summary.append(f"tag: {name} (local)")
    if ctx.confirm(f"Push tag {name} to origin?", force_prompt=True):
        ctx.run(["git", "push", "origin", name])
        ctx.summary[-1] = f"tag: {name} (pushed)"
    else:
        ctx.log.line(f"Not pushed. Later: git push origin {name}")


STEP_FUNCS = {"preflight": step_preflight, "render": step_render, "shopify": step_shopify,
              "theme": step_theme, "smoke": step_smoke, "tag": step_tag}


# --------------------------------------------------------------------------- main

def parse_args(argv: list[str]):
    p = argparse.ArgumentParser(prog="pnpm release", description="Guided DSG Quotes release (Shopify + Render).")
    p.add_argument("--dry-run", action="store_true", help="print what would happen, change nothing")
    p.add_argument("--yes", "-y", action="store_true", help="skip y/n prompts (live theme push and tag push still ask)")
    p.add_argument("--only", action="append", default=[], metavar="STEP", help=f"run only this step (repeatable): {', '.join(STEPS)}")
    p.add_argument("--skip", action="append", default=[], metavar="STEP", help="skip this step (repeatable)")
    a = p.parse_args(argv)
    a.only = [s for x in a.only for s in x.split(",") if s]
    a.skip = [s for x in a.skip for s in x.split(",") if s]
    for s in a.only + a.skip:
        if s not in STEPS:
            p.error(f"unknown step '{s}' (choose from {', '.join(STEPS)})")
    return a


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    cfg = json.loads((HERE / "release.config.json").read_text(encoding="utf-8"))
    masker = Masker([os.environ.get("RENDER_API_KEY", "")])
    log = Log(masker, HERE / "logs" / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.log")
    ctx = Ctx(args, cfg, log)
    log.line("DSG Quotes release" + (" (DRY RUN: nothing will change)" if ctx.dry else ""))
    log.line(f"Log file: {log.path}")
    code = 0
    try:
        for step in STEPS:
            if ctx.wanted(step):
                STEP_FUNCS[step](ctx)
            else:
                log.line(f"(skipping {step})")
    except ReleaseError as e:
        log.line("")
        log.line(f"STOPPED: {e}")
        code = 1
    except KeyboardInterrupt:
        log.line("\nInterrupted.")
        code = 130
    log.line("")
    log.line("Summary:" if ctx.summary else "Summary: nothing changed.")
    for s in ctx.summary:
        log.line("  - " + s)
    log.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
