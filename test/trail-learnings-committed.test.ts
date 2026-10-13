/**
 * The activation count: at session start, a `learnings_committed` event when
 * more learnings are committed on HEAD than at the last session in that clone,
 * and nothing when the count is the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackLearningsCommitted } from "../src/claude/hooks.js";
import { queuePath } from "../src/telemetry/queue.js";
import { CI_ENV_VARS } from "../src/telemetry/gate.js";
import { tmpRepo } from "./helpers.js";

// A scratch home with telemetry on, so the queue can be read back.
const HOME = mkdtempSync(join(tmpdir(), "learnings-committed-home-"));
process.env.HOME = HOME;
process.env.TRAIL_HOME = join(HOME, ".trail");
process.env.GRAFT_POSTHOG_KEY = "phc_test_key";
for (const k of ["DO_NOT_TRACK", ...CI_ENV_VARS]) delete process.env[k];

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Priya", "-c", "user.email=p@acme.test", ...args], { cwd: d });
}

function commitLearning(d: string, name: string) {
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(d, ".trail", "learnings", name), "---\ntitle: x\n---\n## Decided\ny\n");
  git(d, ["add", "."]);
  git(d, ["commit", "-qm", name]);
}

function sent(): { event: string; properties: Record<string, string> }[] {
  try {
    return readFileSync(queuePath(HOME), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "learnings_committed");
  } catch {
    return [];
  }
}

test("counted when committed learnings go up, not when they stay the same", () => {
  const d = tmpRepo("learnings-committed");
  git(d, ["init", "-q", "-b", "main"]);
  commitLearning(d, "a.md");
  trackLearningsCommitted(d);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0]!.properties.first_look, "true", "a clone's first look is marked, so existing learnings aren't counted as new");

  trackLearningsCommitted(d);
  assert.equal(sent().length, 1, "the same count sends nothing");

  // Written but not committed yet: not counted.
  writeFileSync(join(d, ".trail", "learnings", "b.md"), "x");
  trackLearningsCommitted(d);
  assert.equal(sent().length, 1);

  commitLearning(d, "b.md");
  trackLearningsCommitted(d);
  assert.equal(sent().length, 2);
  assert.equal(sent()[1]!.properties.first_look, "false");
  assert.ok(sent()[1]!.properties.added_bucket);
  assert.ok(sent()[1]!.properties.total_bucket);
});
