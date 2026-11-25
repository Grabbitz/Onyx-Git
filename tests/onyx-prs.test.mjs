// node tests/onyx-prs.test.mjs — checks the pure parts of the Pull requests page: list/detail/diff parsing, search, sort.
import fs from "fs";
import assert from "assert";
const src = fs.readFileSync(new URL("../mods/onyx-prs/main.js", import.meta.url), "utf8");
const a = src.indexOf("const MAX_DIFF_ROWS"), b = src.indexOf("// ── the view");
const { parseList, parseDetail, parseDiff, matches, sortPRs, ago } = new Function(
  src.slice(a, b).replace(/export /g, "") + "return { parseList, parseDetail, parseDiff, matches, sortPRs, ago };")();

const node = (n, o = {}) => ({ number: n, title: `t${n}`, url: "u", state: "OPEN", isDraft: false, merged: false, additions: n, deletions: 1,
  changedFiles: 2, createdAt: `2026-01-0${n}T00:00:00Z`, updatedAt: `2026-02-0${n}T00:00:00Z`, author: { login: "me" },
  repository: { nameWithOwner: "o/r" }, labels: { nodes: [{ name: "Bug" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...o });
const list = parseList(JSON.stringify({ data: {
  a: { issueCount: 99, nodes: [node(1), node(2, { merged: true, state: "CLOSED" }), node(3, { commits: { nodes: [] } }), {}] },
  r: { issueCount: 0, nodes: [] } } }));
assert.equal(list.authored.count, 99);
assert.equal(list.authored.prs.length, 3);                       // the empty node is dropped
assert.equal(list.authored.prs[1].state, "MERGED");              // merged beats CLOSED
assert.equal(list.authored.prs[0].checks, "pass");
assert.equal(list.authored.prs[2].checks, null);

const prs = list.authored.prs;
assert.ok(matches(prs[0], "T1 me"));
assert.ok(matches(prs[0], "label:bug"));
assert.ok(!matches(prs[0], "label:feature"));
assert.ok(!matches(prs[0], "nope"));
assert.deepStrictEqual(sortPRs(prs, "updated").map((p) => p.number), [3, 2, 1]);
assert.deepStrictEqual(sortPRs(prs, "size").map((p) => p.number), [3, 2, 1]);

const d = parseDetail(JSON.stringify({
  body: "hi", headRefName: "f", baseRefName: "main", author: { login: "me" }, additions: 5, deletions: 1, changedFiles: 1,
  reviewRequests: [{ login: "bob" }, { login: "amy" }], latestReviews: [{ author: { login: "amy" }, state: "APPROVED" }],
  labels: [{ name: "x", color: "fff" }], mergedAt: "2026-03-01T00:00:00Z",
  comments: [{ author: { login: "me" }, body: "c", createdAt: "2026-02-01T00:00:00Z" }],
  reviews: [{ author: { login: "amy" }, state: "APPROVED", body: "", submittedAt: "2026-02-02T00:00:00Z" }],
  commits: [{ messageHeadline: "fix", committedDate: "2026-01-01T00:00:00Z", authors: [{ login: "me" }] }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "b", status: "IN_PROGRESS" },
    { __typename: "CheckRun", name: "c", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "StatusContext", context: "d", state: "SUCCESS" }] }));
assert.deepStrictEqual(d.reviewers, [{ name: "bob", state: "PENDING" }, { name: "amy", state: "APPROVED" }]);
assert.deepStrictEqual(d.checks.map((c) => c.outcome), ["pass", "pending", "fail", "pass"]);
assert.deepStrictEqual(d.timeline.map((e) => e.kind), ["commit", "comment", "review", "merged"]);

const rows = parseDiff("diff --git a/x.js b/x.js\nindex 1..2 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline\n");
assert.deepStrictEqual(rows.map((r) => r.t), ["file", "hunk", "ctx", "del", "add"]);   // header lines and "\ No newline" are skipped
assert.equal(rows[0].path, "x.js");
assert.equal(parseDiff("diff --git a/a b/a\n@@ -1 +1 @@\n" + "+x\n".repeat(6000)).length, 5001);

assert.equal(ago(Date.now() - 22 * 3600e3), "22h ago");
console.log("onyx-prs: all checks passed");
