import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../../lib/harness.js";

test("workspace sandbox self-check proves isolation and cleanup barrier", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-farm-workspace-sandbox-"));
  const dataDir = join(root, "data");
  const worktree = join(root, "worktree");
  const previousDataDir = process.env.AGENT_FARM_DATA_DIR;
  const previousHost = process.env.HOST;
  process.env.AGENT_FARM_DATA_DIR = dataDir;
  process.env.HOST = "127.0.0.1";
  process.env.AGENT_FARM_DISABLE_USER_SETTINGS = "1";
  try {
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "README.md"), "sandbox fixture\n");
    const {
      cleanupWorkspaceSandbox,
      createWorkspaceSandbox,
      markWorkspaceSandboxReleased,
      runWorkspaceCommand,
      verifyWorkspaceSandbox,
    } = await import("../../../server/src/agent-sandbox.js");

    const sandbox = await createWorkspaceSandbox(worktree, `run-${Date.now()}`);
    await verifyWorkspaceSandbox(sandbox);

    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const insidePath = join(sandbox.cwd, "inside.txt");
    const inside = await runWorkspaceCommand(
      sandbox,
      `printf ok > ${quote(insidePath)} && /bin/cat ${quote(insidePath)}`,
      { timeoutMs: 10_000 },
    );
    assert.equal(inside.status, "succeeded");
    assert.match(inside.stdout, /ok/);
    assert.equal(await readFile(insidePath, "utf8"), "ok");

    await markWorkspaceSandboxReleased(sandbox);
    const proof = await cleanupWorkspaceSandbox(sandbox);
    assert.equal(proof?.closed, true);
    assert.equal(proof?.directoryRemoved, true);
    assert.equal(proof?.retainedForRecovery, false);
  } finally {
    if (previousDataDir === undefined) delete process.env.AGENT_FARM_DATA_DIR;
    else process.env.AGENT_FARM_DATA_DIR = previousDataDir;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace sandbox can read linked-worktree git metadata and cannot write the common dir", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-farm-sandbox-git-"));
  const dataDir = join(root, "data");
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const previousDataDir = process.env.AGENT_FARM_DATA_DIR;
  const previousHost = process.env.HOST;
  process.env.AGENT_FARM_DATA_DIR = dataDir;
  process.env.HOST = "127.0.0.1";
  process.env.AGENT_FARM_DISABLE_USER_SETTINGS = "1";
  try {
    await mkdir(repo, { recursive: true });
    git(repo, "init");
    git(repo, "config", "user.email", "agent-farm@localhost");
    git(repo, "config", "user.name", "Agent Farm");
    await writeFile(join(repo, "README.md"), "sandbox git fixture\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "initial");
    git(repo, "worktree", "add", worktree, "HEAD");

    const {
      cleanupWorkspaceSandbox,
      createWorkspaceSandbox,
      gitReadRoots,
      markWorkspaceSandboxReleased,
      runWorkspaceCommand,
      verifyWorkspaceSandbox,
    } = await import("../../../server/src/agent-sandbox.js");

    const sandbox = await createWorkspaceSandbox(worktree, `run-git-${Date.now()}`);
    await verifyWorkspaceSandbox(sandbox);
    const gitRoots = await gitReadRoots(sandbox.cwd);
    assert.ok(gitRoots.length >= 1, "linked worktree must expose gitdir/commondir read roots");
    const commonDir = await realpath(join(repo, ".git"));
    assert.ok(
      gitRoots.some((rootPath) => rootPath === commonDir),
      `expected common dir ${commonDir} in ${gitRoots.join(",")}`,
    );

    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const probe = join(commonDir, `agent-farm-sandbox-denied-${Date.now()}`);
    const denied = await runWorkspaceCommand(
      sandbox,
      `printf pwned > ${quote(probe)}`,
      { timeoutMs: 10_000 },
    );
    assert.notEqual(denied.status, "succeeded");
    await assert.rejects(() => readFile(probe, "utf8"));

    const insidePath = join(sandbox.cwd, "inside-git.txt");
    const inside = await runWorkspaceCommand(
      sandbox,
      `printf ok > ${quote(insidePath)} && /bin/cat ${quote(insidePath)}`,
      { timeoutMs: 10_000 },
    );
    assert.equal(inside.status, "succeeded");
    assert.equal(await readFile(insidePath, "utf8"), "ok");

    await markWorkspaceSandboxReleased(sandbox);
    const proof = await cleanupWorkspaceSandbox(sandbox);
    assert.equal(proof?.closed, true);
    assert.equal(proof?.directoryRemoved, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.AGENT_FARM_DATA_DIR;
    else process.env.AGENT_FARM_DATA_DIR = previousDataDir;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
    await rm(root, { recursive: true, force: true });
  }
});
