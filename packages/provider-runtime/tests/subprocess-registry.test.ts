/**
 * Subprocess registry — lifecycle + tree-kill regression suite.
 *
 * Covers docs/subprocess-lifecycle-requirements.md acceptance criteria:
 *   #1/#5 — registry tracks each spawn and returns to baseline on exit
 *   #3    — cancelling kills the child tree promptly
 *   #4    — tree-kill takes down a grandchild sleeper, not just the child
 *
 * These tests spawn REAL short-lived node processes (no mocks) because the
 * whole point is OS-level process-group / tree-kill behavior. POSIX uses
 * detached process groups; the grandchild assertion is POSIX-specific
 * (Windows tree-kill via taskkill is exercised by the same code path but
 * pid-liveness probing differs, so we gate that assertion off Windows).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { managedSpawn, killProcessTree, killAll, liveCount, _registry } =
  require("../src/subprocess-registry");

const IS_WINDOWS = process.platform === "win32";
const NODE = process.execPath;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POSIX pid-liveness probe (signal 0). Mirrors tmpfile-sweeper._isPidAlive. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e.code === "EPERM"; }
}

async function waitForExit(child: any, timeoutMs = 4000): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

test("managedSpawn registers the child and deregisters on natural exit", async () => {
  const before = liveCount();
  // Exits ~immediately.
  const child = managedSpawn(NODE, ["-e", "process.exit(0)"], {}, { label: "test-quick" });
  assert.ok(child.pid, "child should have a pid");
  assert.equal(liveCount(), before + 1, "registry grows by one while alive");
  assert.ok(_registry.has(child.pid), "pid is tracked");

  await waitForExit(child);
  // exit handler is async (once('exit')) — let the microtask/IO turn flush.
  await sleep(50);
  assert.equal(_registry.has(child.pid), false, "pid removed after exit");
  assert.equal(liveCount(), before, "registry returns to baseline");
});

test("killProcessTree terminates a tracked child (cancellation, acceptance #3)", async () => {
  const before = liveCount();
  // Long-lived: holds the event loop open for 60s.
  const child = managedSpawn(NODE, ["-e", "setTimeout(()=>{}, 60000)"], {}, { label: "test-long" });
  const pid = child.pid;
  assert.ok(isPidAlive(pid), "child is alive after spawn");

  const t0 = Date.now();
  killProcessTree(child, "SIGTERM");
  await waitForExit(child);
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 1500, `child died promptly (${elapsed}ms < 1500ms)`);
  await sleep(50);
  assert.equal(_registry.has(pid), false, "killed child is deregistered");
  assert.equal(liveCount(), before, "registry returns to baseline after kill");
});

test("killProcessTree is idempotent — double kill / dead child never throws", async () => {
  const child = managedSpawn(NODE, ["-e", "process.exit(0)"], {}, { label: "test-idem" });
  await waitForExit(child);
  await sleep(50);
  // Already-exited child; both calls must be no-ops, not throws.
  assert.doesNotThrow(() => killProcessTree(child, "SIGTERM"));
  assert.doesNotThrow(() => killProcessTree(child, "SIGKILL"));
  // Garbage input is also safe.
  assert.doesNotThrow(() => killProcessTree(null));
  assert.doesNotThrow(() => killProcessTree({ pid: undefined }));
});

test("tree-kill reaps a grandchild sleeper, not just the direct child (acceptance #4)", async (t: any) => {
  if (IS_WINDOWS) {
    t.skip("POSIX-specific: grandchild pid-liveness probe via signal 0");
    return;
  }
  // The direct child spawns a detached grandchild sleeper, prints the
  // grandchild pid on stdout, then idles. We capture the grandchild pid,
  // tree-kill the child, and assert BOTH die. Without process-group kill
  // the grandchild would survive (the original athena.server leak).
  const childSrc = `
    const { spawn } = require("child_process");
    const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    process.stdout.write("GPID:" + g.pid + "\\n");
    setTimeout(() => {}, 60000);
  `;
  const child = managedSpawn(NODE, ["-e", childSrc], { stdio: ["ignore", "pipe", "ignore"] }, { label: "test-tree" });

  // Read the grandchild pid from the child's stdout.
  const grandPid = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("timed out waiting for grandchild pid")), 4000);
    child.stdout.on("data", (d: any) => {
      buf += d.toString();
      const m = buf.match(/GPID:(\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
  });

  assert.ok(isPidAlive(child.pid), "child alive");
  assert.ok(isPidAlive(grandPid), "grandchild alive");

  killProcessTree(child, "SIGTERM");
  await waitForExit(child);

  // Give the grandchild a moment to receive the group signal and exit.
  let grandDead = false;
  for (let i = 0; i < 30; i++) {
    if (!isPidAlive(grandPid)) { grandDead = true; break; }
    await sleep(50);
  }
  assert.equal(grandDead, true, "grandchild sleeper was reaped by the group kill");
});

test("H1: killProcessTree on an already-exited child never signals (no pgid reuse)", async () => {
  // After exit Node retains child.pid (it does NOT go null). A naive
  // killProcessTree would fire process.kill(-pid) against a dead group whose
  // pgid the kernel may have recycled for an unrelated live tree. Assert the
  // guard short-circuits: zero process.kill calls for the exited child.
  const child = managedSpawn(NODE, ["-e", "process.exit(0)"], {}, { label: "test-h1" });
  const pid = child.pid;
  await waitForExit(child);
  await sleep(50);
  assert.notEqual(child.pid, null, "Node retains pid after exit");
  assert.notEqual(child.exitCode, null, "exitCode is set after exit");

  const realKill = process.kill;
  const calls: any[] = [];
  (process as any).kill = (p: number, sig?: any) => { calls.push([p, sig]); return realKill.call(process, p, sig); };
  try {
    killProcessTree(child, "SIGKILL");
  } finally {
    (process as any).kill = realKill;
  }
  const signalledTarget = calls.some(([p]) => p === pid || p === -pid);
  assert.equal(signalledTarget, false, "no kill signal sent to the exited child's pid/pgid");
});

test("killAll reaps every tracked child (onunload / shutdown path)", async () => {
  const a = managedSpawn(NODE, ["-e", "setTimeout(()=>{}, 60000)"], {}, { label: "test-a" });
  const b = managedSpawn(NODE, ["-e", "setTimeout(()=>{}, 60000)"], {}, { label: "test-b" });
  assert.ok(liveCount() >= 2);

  const killed = killAll("SIGTERM");
  assert.ok(killed >= 2, "killAll reported killing the tracked children");

  await waitForExit(a);
  await waitForExit(b);
  await sleep(50);
  assert.equal(_registry.has(a.pid), false);
  assert.equal(_registry.has(b.pid), false);
});
