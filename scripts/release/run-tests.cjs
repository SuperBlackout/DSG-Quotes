// Runs the Python unit tests with whichever Python 3 interpreter is available (py -3, python, python3).
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const candidates = [["py", "-3"], ["python"], ["python3"]];
const args = ["-X", "utf8", "-m", "unittest", "discover", "-s", "tests", "-t", "."];
for (const [cmd, ...pre] of candidates) {
  const probe = spawnSync(cmd, [...pre, "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 3)"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) continue;
  const run = spawnSync(cmd, [...pre, ...args], { cwd: __dirname, stdio: "inherit" });
  process.exit(run.status ?? 1);
}
console.error("release-tool tests: Python 3.10+ not found (tried py -3, python, python3).");
process.exit(1);
