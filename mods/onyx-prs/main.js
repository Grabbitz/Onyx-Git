// Onyx PRs: a Pull requests page in the work area (the layout's "view" stack, child "prs"), in the
// manner of T3 Code's: your pull requests on the left (Authored / Review requested, searchable,
// sortable, filterable), the one you pick on the right (Summary · Timeline · Code).
// Reads and acts on GitHub through `gh` only (`gh auth login` once).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, spaces, focused, layout, theme } from "herdr";

const FIELDS = "number title url state isDraft merged additions deletions changedFiles createdAt updatedAt author{login} " +
  "repository{nameWithOwner} labels(first:8){nodes{name color}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}";
const LIST_QUERY = `query($a:String!,$r:String!){a:search(query:$a,type:ISSUE,first:60){issueCount nodes{...on PullRequest{${FIELDS}}}}` +
  ` r:search(query:$r,type:ISSUE,first:60){issueCount nodes{...on PullRequest{${FIELDS}}}}}`;
const VIEW_FIELDS = "number,title,body,state,isDraft,author,headRefName,baseRefName,additions,deletions,changedFiles,files," +
  "reviewRequests,latestReviews,labels,comments,reviews,commits,statusCheckRollup,updatedAt,mergedAt,url";
const STATES = { open: "is:open", merged: "is:merged", closed: "is:closed", any: "" };
const SORTS = [["updated", "Recently updated"], ["created", "Newest"], ["size", "Largest change"]];
const MAX_DIFF_ROWS = 5000;

// ── pure helpers (tests/onyx-prs.test.mjs runs these) ──────────────────────────────────────────

// statusCheckRollup.state -> "pass" | "fail" | "pending" | null
export function rollup(state) {
  if (state === "SUCCESS") return "pass";
  if (state === "FAILURE" || state === "ERROR") return "fail";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return null;
}

// The GraphQL search answer -> { authored, review }, each { count, prs: [PR] }.
export function parseList(json) {
  const data = JSON.parse(json).data;
  const one = (s) => ({
    count: s?.issueCount ?? 0,
    prs: (s?.nodes ?? []).filter((n) => n && n.number).map((n) => ({
      key: `${n.repository.nameWithOwner}#${n.number}`, number: n.number, title: n.title, url: n.url,
      repo: n.repository.nameWithOwner, author: n.author?.login ?? "ghost",
      state: n.merged ? "MERGED" : n.state, draft: n.isDraft, add: n.additions, del: n.deletions, files: n.changedFiles,
      created: Date.parse(n.createdAt), updated: Date.parse(n.updatedAt),
      checks: rollup(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
      labels: (n.labels?.nodes ?? []).map((l) => l.name),
    })),
  });
  return { authored: one(data.a), review: one(data.r) };
}

// Search text: words must all appear in "#n title author repo"; `label:x` needs that label.
export function matches(pr, text) {
  const hay = `#${pr.number} ${pr.title} ${pr.author} ${pr.repo}`.toLowerCase();
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((w) =>
    w.startsWith("label:") ? pr.labels.some((l) => l.toLowerCase() === w.slice(6)) : hay.includes(w));
}

export function sortPRs(prs, how) {
  const key = how === "size" ? (p) => p.add + p.del : how === "created" ? (p) => p.created : (p) => p.updated;
  return [...prs].sort((a, b) => key(b) - key(a));
}

// gh pr view --json -> what the right side shows.
export function parseDetail(json) {
  const d = JSON.parse(json);
  const outcome = (c) => c.__typename === "StatusContext"
    ? ({ SUCCESS: "pass", PENDING: "pending", EXPECTED: "pending" }[c.state] ?? "fail")
    : c.status !== "COMPLETED" ? "pending" : c.conclusion === "SUCCESS" ? "pass" : ["NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "skip" : "fail";
  const reviewers = new Map();
  for (const r of d.reviewRequests ?? []) reviewers.set(r.login ?? r.name ?? r.slug, "PENDING");
  for (const r of d.latestReviews ?? []) reviewers.set(r.author?.login, r.state);
  const timeline = [
    ...(d.comments ?? []).map((c) => ({ kind: "comment", who: c.author?.login, text: c.body, at: Date.parse(c.createdAt) })),
    ...(d.reviews ?? []).map((r) => ({ kind: "review", state: r.state, who: r.author?.login, text: r.body, at: Date.parse(r.submittedAt) })),
    ...(d.commits ?? []).map((c) => ({ kind: "commit", who: c.authors?.[0]?.login ?? c.authors?.[0]?.name, text: c.messageHeadline, at: Date.parse(c.committedDate) })),
    ...(d.mergedAt ? [{ kind: "merged", at: Date.parse(d.mergedAt) }] : []),
  ].filter((i) => !Number.isNaN(i.at)).sort((a, b) => a.at - b.at);
  return {
    body: d.body ?? "", head: d.headRefName, base: d.baseRefName, author: d.author?.login ?? "ghost",
    add: d.additions, del: d.deletions, files: d.changedFiles, comments: (d.comments ?? []).length,
    reviewers: [...reviewers].map(([name, state]) => ({ name, state })),
    labels: (d.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    checks: (d.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context, url: c.detailsUrl ?? c.targetUrl, outcome: outcome(c) })),
    timeline,
  };
}

// A unified diff -> rows: { t: "file", path } | { t: "hunk"|"add"|"del"|"ctx", text }. Capped.
export function parseDiff(text) {
  const rows = [];
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (rows.length >= MAX_DIFF_ROWS) { rows.push({ t: "hunk", text: "… diff truncated, see it on GitHub" }); break; }
    if (line.startsWith("diff --git ")) { rows.push({ t: "file", path: line.slice(11).split(" b/").pop() }); inHunk = false; }
    else if (line.startsWith("@@")) { rows.push({ t: "hunk", text: line }); inHunk = true; }
    else if (!inHunk) continue; // index / ---/+++ / mode lines
    else if (line.startsWith("+")) rows.push({ t: "add", text: line });
    else if (line.startsWith("-")) rows.push({ t: "del", text: line });
    else if (line.startsWith(" ")) rows.push({ t: "ctx", text: line });
  }
  return rows;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(ms).toLocaleDateString();
}

// ── the view ───────────────────────────────────────────────────────────────────────────────────

const ICONS = "mods/gh-prs/icons"; // herdr-github's, installed as gh-prs by install.sh
const ico = (name, color, size = 14) => svg(`${ICONS}/${name}.svg`).flex_none().size(size).text_color(color);
const MONO = "JetBrains Mono";
const HUES = ["#f59e0b", "#60a5fa", "#34d399", "#f472b6", "#a78bfa", "#fb7185", "#2dd4bf"];
const HEAD_H = 30, ROW_H = 54, DIFF_H = 18, FILE_H = 30;

const avatar = (t, name, size = 16) => div().size(size).flex_none().rounded_full().flex().items_center().justify_center()
  .text_size(Math.round(size * 0.6)).font_bold().text_color(t.background)
  .bg(HUES[[...(name ?? "?")].reduce((h, c) => h + c.charCodeAt(0), 0) % HUES.length]).child((name ?? "?")[0].toUpperCase());

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}

export default class Prs extends View {
  init(_props, cx) {
    this.data = null; this.loading = false; this.err = ""; this.note = ""; this.noteErr = false;
    this.sort = localStorage.getItem("onyx-prs.sort") ?? "updated";
    this.state = localStorage.getItem("onyx-prs.state") ?? "open";
    this.scope = localStorage.getItem("onyx-prs.scope") ?? "all";
    this.hideDrafts = localStorage.getItem("onyx-prs.hideDrafts") === "1";
    this.query = ""; this.menu = null;
    this.sel = null; this.tab = "summary"; this.detail = null; this.diff = null;
    this.scroll = VirtualListScrollHandle.new(); this.dscroll = VirtualListScrollHandle.new();
    this.loadedAt = 0; this.wasShown = false;
    this.input = InputState.new({ placeholder: "Search pull requests, or label:bug" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.load(cx);
    // ponytail: polls only while the page is showing; a push (webhook) would need a server.
    cx.timer.every(60000, (cx) => { if (this.shown()) this.load(cx); });
  }

  shown() { return findNode(layout(), "view")?.active === "prs"; }

  say(text, cx, isErr = false) {
    this.note = text; this.noteErr = isErr; cx.notify();
    cx.timer.after(6000, (cx) => { if (this.note === text) { this.note = ""; cx.notify(); } });
  }

  // "owner/name" of the focused folder's repo, or "".
  async focusedRepo() {
    const f = focused();
    if (!f?.cwd) return "";
    const on = spaces().find((s) => s.id === f.space)?.machine ?? undefined;
    const r = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: f.cwd, on }).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : "";
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true; this.err = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const repo = this.scope === "repo" ? await this.focusedRepo() : "";
        if (this.scope === "repo" && !repo) this.say("The focused folder isn't a GitHub repo: showing all.", cx, true);
        const q = (who) => `is:pr ${who} ${STATES[this.state] ?? ""} ${repo ? `repo:${repo}` : ""} sort:updated-desc`;
        const r = await exec("gh", ["api", "graphql", "-f", `query=${LIST_QUERY}`, "-f", `a=${q("author:@me")}`, "-f", `r=${q("review-requested:@me")}`]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `gh exit ${r.code}`);
        this.data = parseList(r.stdout);
        this.loadedAt = Date.now();
        const first = this.groups()[0]?.prs[0];
        if (first && !(this.sel && this.groups().some((g) => g.prs.some((p) => p.key === this.sel.key)))) this.pick(first, cx);
      } catch (e) {
        this.err = `${e?.message ?? e}${/auth|login|token/i.test(String(e?.message)) ? " — run `gh auth login`" : ""}`;
      }
      this.loading = false; cx.notify();
    });
  }

  groups() {
    if (!this.data) return [];
    const filtered = Boolean(this.query.trim()) || this.hideDrafts;
    return [["Authored", this.data.authored], ["Review requested", this.data.review]].map(([label, g]) => {
      const prs = sortPRs(g.prs.filter((p) => !(this.hideDrafts && p.draft) && matches(p, this.query)), this.sort);
      return { label, prs, count: filtered ? prs.length : Math.max(g.count, prs.length) };
    }).filter((g) => g.prs.length);
  }

  pick(pr, cx) {
    this.sel = pr; this.tab = "summary"; this.detail = null; this.diff = null; this.dscroll = VirtualListScrollHandle.new();
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["pr", "view", String(pr.number), "-R", pr.repo, "--json", VIEW_FIELDS]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (this.sel?.key !== pr.key) return;
      this.detail = r.code !== 0 ? { error: r.stderr.trim().split("\n").pop() || `gh exit ${r.code}` } : parseDetail(r.stdout);
      cx.notify();
    });
  }

  setTab(tab, cx) {
    this.tab = tab; cx.notify();
    const pr = this.sel;
    if (tab !== "code" || this.diff || !pr) return;
    this.diff = { loading: true };
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["pr", "diff", String(pr.number), "-R", pr.repo, "--color", "never"]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (this.sel?.key !== pr.key) return;
      this.diff = r.code === 0 ? { rows: parseDiff(r.stdout) } : { error: r.stderr.trim().split("\n").pop() || `gh exit ${r.code}` };
      cx.notify();
    });
  }

  // `gh pr checkout` in the focused folder, when that folder is this PR's repo.
  checkout(cx) {
    cx.spawn((cx) => this.doCheckout(cx));
  }

  async doCheckout(cx) {
    const pr = this.sel;
    const f = focused();
    if (!pr || !f?.cwd) return this.say("Focus a terminal in the repo first.", cx, true);
    const here = await this.focusedRepo();
    if (here.toLowerCase() !== pr.repo.toLowerCase()) return this.say(`The focused folder is ${here || "not a GitHub repo"}, not ${pr.repo}. Copy the command and run it there.`, cx, true);
    const on = spaces().find((s) => s.id === f.space)?.machine ?? undefined;
    const r = await exec("gh", ["pr", "checkout", String(pr.number), "-R", pr.repo], { cwd: f.cwd, on });
    if (r.code === 0) this.say(`Checked out #${pr.number} in ${f.cwd}`, cx);
    else this.say(r.stderr.trim().split("\n").pop() || `gh exit ${r.code}`, cx, true);
  }

  setPref(name, value, cx, reload = false) {
    this[name] = value; localStorage.setItem(`onyx-prs.${name}`, typeof value === "boolean" ? (value ? "1" : "") : value);
    this.menu = null; cx.notify();
    if (reload) this.load(cx);
  }

  // ── left: search, toolbar, list ──────────────────────────────────────────────────────────────

  button(t, id, label, on, action, extra) {
    return h_flex().id(id).h(28).px(10).gap(6).items_center().flex_none().rounded(7).border_1().border_color(t.border)
      .text_size(12.5).text_color(on ? t.foreground : t.muted).bg(on ? t.selected : t.background).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(action).child(label).when(Boolean(extra), (el) => el.child(extra));
  }

  toolbar(t) {
    const n = (this.state !== "any" ? 1 : 0) + (this.hideDrafts ? 1 : 0);
    const toggle = (m) => (_e, cx) => { this.menu = this.menu === m ? null : m; cx.notify(); };
    return h_flex().flex_none().px(12).pb(8).gap(6).items_center()
      .child(this.button(t, "sort", "↕ Sort", this.menu === "sort", toggle("sort")))
      .child(this.button(t, "filters", "Filters", this.menu === "filters", toggle("filters"),
        n > 0 ? div().px(5).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(String(n)) : null))
      .child(this.button(t, "scope", this.scope === "repo" ? "This repo" : "All", this.menu === "scope", toggle("scope")))
      .child(div().flex_1())
      .child(div().id("refresh").size(28).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(t.border)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => this.load(cx))
        .child(svg("mods/onyx-quota/refresh.svg").size(14).text_color(t.dim).when(this.loading, (el) => el.spin(900))));
  }

  menuView(t) {
    const rows = {
      sort: SORTS.map(([id, label]) => [label, this.sort === id, (cx) => this.setPref("sort", id, cx)]),
      scope: [["All repositories", this.scope === "all", (cx) => this.setPref("scope", "all", cx, true)],
        ["Focused folder's repo", this.scope === "repo", (cx) => this.setPref("scope", "repo", cx, true)]],
      filters: [...[["open", "Open"], ["merged", "Merged"], ["closed", "Closed"], ["any", "Any state"]]
        .map(([id, label]) => [label, this.state === id, (cx) => this.setPref("state", id, cx, true)]),
        ["Hide drafts", this.hideDrafts, (cx) => this.setPref("hideDrafts", !this.hideDrafts, cx)]],
    }[this.menu];
    return v_flex().flex_none().mx(12).mb(8).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover ?? t.chrome)
      .children(rows.map(([label, on, act], i) => h_flex().id(`menu-${i}`).h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => act(cx)).text_size(12.5).text_color(t.foreground)
        .child(div().w(12).flex_none().text_color(t.accent ?? t.ansi4).child(on ? "✓" : "")).child(label)));
  }

  prRow(t, pr, on) {
    const color = pr.state === "MERGED" ? t.ansi5 : pr.state === "CLOSED" ? t.ansi1 : pr.draft ? (t.ansi8 ?? t.dim) : t.ansi2;
    const icon = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "pr";
    const check = { pass: ["done", t.ansi2], fail: ["cross", t.ansi1], pending: ["idle", t.ansi3] }[pr.checks];
    return h_flex().h(ROW_H - 2).mx(8).px(10).gap(10).items_start().rounded(8).cursor_pointer().pt(8)
      .bg(on ? t.selected : t.background).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .child(div().pt(2).child(ico(icon, color, 15)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().font_family(MONO).text_size(12).text_color(t.muted).child(`#${pr.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(pr.title))
          .when(Boolean(check), (el) => el.child(ico(check[0], check[1], 13)))
          .child(h_flex().flex_none().gap(4).font_family(MONO).text_size(11.5)
            .child(div().text_color(t.ansi2).child(`+${pr.add}`)).child(div().text_color(t.ansi1).child(`-${pr.del}`))))
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
          .child(avatar(t, pr.author, 14))
          .child(div().flex_1().min_w(0).truncate().child(`${pr.author}  ${pr.repo}`))
          .child(div().flex_none().child(ago(pr.updated)))));
  }

  listView(t) {
    const entries = [];
    for (const g of this.groups()) {
      entries.push({ key: `h-${g.label}`, h: HEAD_H, el: () => h_flex().h(HEAD_H).px(20).gap(8).items_center().text_size(12).text_color(t.dim)
        .child(g.label).child(div().text_color(t.dim).child(String(g.count))).child(div().flex_1().h(1).bg(t.border)) });
      for (const pr of g.prs) entries.push({ key: `${g.label}-${pr.key}`, pr, h: ROW_H, el: () => div().h(ROW_H).child(this.prRow(t, pr, this.sel?.key === pr.key)) });
    }
    if (!entries.length) {
      const text = this.err || (this.loading || !this.data ? "Loading…" : "No pull requests match.");
      return div().px(20).py(12).text_size(12.5).text_color(this.err ? t.ansi1 : t.dim).child(text);
    }
    return div().relative().flex_1().min_h(0)
      .child(v_virtual_list("prs-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
        (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
        .on_item_click((key, cx) => { const pr = entries.find((e) => e.key === key)?.pr; if (pr) this.pick(pr, cx); }))
      .child(Scrollbar.vertical("prs-rows").absolute().inset_0());
  }

  // ── right: the picked pull request ───────────────────────────────────────────────────────────

  chip(t, label, color) {
    return h_flex().h(22).px(8).gap(5).items_center().flex_none().rounded(6).border_1().border_color(t.border).text_size(12).text_color(color ?? t.muted).child(label);
  }

  detailView(t) {
    const pr = this.sel, d = this.detail;
    if (!pr) return div().flex_1().flex().items_center().justify_center().text_size(13).text_color(t.dim).child("Pick a pull request");
    const merged = pr.state === "MERGED", closed = pr.state === "CLOSED";
    const stateColor = merged ? t.ansi5 : closed ? t.ansi1 : pr.draft ? (t.ansi8 ?? t.dim) : t.ansi2;
    const stateWord = merged ? "Merged" : closed ? "Closed" : pr.draft ? "Draft" : "Open";
    const counts = (o) => (d?.checks ?? []).filter((c) => c.outcome === o).length;
    const checkText = !d?.checks?.length ? ["No checks", t.dim] : counts("fail") ? [`${counts("fail")} failing`, t.ansi1]
      : counts("pending") ? [`${counts("pending")} running`, t.ansi3] : ["All checks passed", t.ansi2];
    const cmd = `gh pr checkout ${pr.number}`;
    const flat = (el) => el.border_b_1().border_color(t.border);

    const head = v_flex().flex_none().px(20).pt(14).pb(12).gap(8)
      .child(h_flex().gap(8).items_center()
        .child(h_flex().id("repo-link").gap(4).items_center().cursor_pointer().text_size(12.5).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => cx.open_url(pr.url)).child(`${pr.repo} #${pr.number}`).child(ico("external", t.dim, 11)))
        .child(div().flex_1())
        .when(Boolean(d?.comments), (el) => el.child(this.chip(t, `💬 ${d.comments}`)))
        .child(h_flex().h(22).px(8).gap(5).items_center().rounded(6).bg(stateColor + "26").text_size(12).text_color(stateColor)
          .child(ico(merged ? "merged" : closed ? "closed" : pr.draft ? "draft" : "pr", stateColor, 12)).child(stateWord))
        .when(!merged && !closed, (el) => el.child(this.button(t, "checkout", "Check out", false, (_e, cx) => this.checkout(cx)))))
      .child(div().text_size(17).font_semibold().text_color(t.foreground).line_height(1.35).child(pr.title))
      .child(h_flex().gap(8).items_center().text_size(12.5)
        .child(avatar(t, pr.author, 18)).child(div().text_color(t.foreground).child(pr.author))
        .child(div().text_color(t.dim).child(`· updated ${ago(pr.updated)}`)).child(div().flex_1())
        .child(div().id("cmd").font_family(MONO).text_size(12).text_color(t.muted).cursor_pointer().tooltip("Copy")
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.write_to_clipboard(cmd); this.say(`Copied ${cmd}`, cx); }).child(cmd)))
      .child(h_flex().gap(8).items_center().text_size(12.5)
        .child(div().font_family(MONO).text_color(t.muted).child(`${d?.base ?? "…"} ← ${d?.head ?? "…"}`)).child(div().flex_1())
        .child(div().text_color(t.dim).child(`${pr.files} file${pr.files === 1 ? "" : "s"}`))
        .child(div().font_family(MONO).text_color(t.ansi2).child(`+${pr.add}`)).child(div().font_family(MONO).text_color(t.ansi1).child(`-${pr.del}`)))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(this.noteErr ? t.ansi1 : t.muted).child(this.note)));

    const tabs = flat(h_flex().flex_none().px(20).py(8).gap(2).items_center())
      .child(h_flex().p(2).gap(2).rounded(8).bg(t.chrome)
        .children([["summary", "Summary"], ["timeline", "Timeline"], ["code", "Code"]].map(([id, label]) =>
          div().id(`tab-${id}`).h(26).px(12).flex().items_center().rounded(6).text_size(13).cursor_pointer()
            .bg(this.tab === id ? t.selected : t.chrome).text_color(this.tab === id ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setTab(id, cx)).child(label))))
      .child(div().flex_1())
      .child(h_flex().gap(6).items_center().text_size(12.5).text_color(checkText[1])
        .when(Boolean(d?.checks?.length), (el) => el.child(ico(counts("fail") ? "cross" : counts("pending") ? "idle" : "done", checkText[1], 13))).child(checkText[0]));

    const body = !d ? div().p(20).text_size(12.5).text_color(t.dim).child("Loading…")
      : d.error ? div().p(20).text_size(12.5).text_color(t.ansi1).child(d.error)
      : this.tab === "timeline" ? this.timelineView(t, d) : this.tab === "code" ? this.codeView(t) : this.summaryView(t, d);
    return v_flex().flex_1().min_w(0).h_full().child(head).child(tabs).child(body);
  }

  summaryView(t, d) {
    const field = (label, kids) => h_flex().gap(12).items_center().min_h(26)
      .child(div().flex_none().w(84).text_size(12.5).text_color(t.muted).child(label))
      .child(h_flex().flex_1().gap(6).flex_wrap().items_center().children(kids.length ? kids : [div().text_size(12.5).text_color(t.dim).child("None")]));
    const word = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", PENDING: "requested" };
    const dot = { APPROVED: t.ansi2, CHANGES_REQUESTED: t.ansi1 };
    return v_flex().id("summary").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(10)
      .child(field("Reviewers", d.reviewers.map((r) => this.chip(t, `${r.name} · ${word[r.state] ?? r.state.toLowerCase()}`, dot[r.state]))))
      .child(field("Labels", d.labels.map((l) => h_flex().h(22).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().size(7).rounded_full().bg(`#${l.color}`)).child(l.name))))
      .child(div().mt(6).text_size(12.5).text_color(t.muted).child("Description"))
      .child(d.body.trim()
        ? TextView.markdown(`md-${this.sel.key}`, d.body).selectable(true).text_size(13.5).text_color(t.foreground).on_link_click((url, cx) => cx.open_url(url))
        : div().text_size(12.5).text_color(t.dim).child("No description provided."))
      .child(div().mt(10).text_size(12.5).text_color(t.muted).child(`Checks ${d.checks.length || ""}`))
      .children(d.checks.map((c, i) => {
        const [icon, color] = { pass: ["done", t.ansi2], fail: ["cross", t.ansi1], pending: ["idle", t.ansi3], skip: ["idle", t.dim] }[c.outcome];
        return h_flex().id(`check-${i}`).h(24).gap(8).items_center().text_size(12.5).text_color(t.foreground).when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.open_url(c.url)))
          .child(ico(icon, color, 13)).child(div().min_w(0).truncate().child(c.name));
      }));
  }

  timelineView(t, d) {
    const said = { COMMENTED: "reviewed", APPROVED: "approved", CHANGES_REQUESTED: "requested changes", DISMISSED: "had a review dismissed" };
    if (!d.timeline.length) return div().p(20).text_size(12.5).text_color(t.dim).child("Nothing yet.");
    return v_flex().id("timeline").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(14)
      .children(d.timeline.map((e, i) => {
        const what = e.kind === "comment" ? "commented" : e.kind === "review" ? said[e.state] ?? "reviewed" : e.kind === "commit" ? `committed: ${e.text}` : "merged this pull request";
        return h_flex().gap(10).items_start()
          .child(e.kind === "commit" || e.kind === "merged" ? div().size(18).flex_none().flex().items_center().justify_center().child(ico(e.kind === "merged" ? "merged" : "branch", e.kind === "merged" ? t.ansi5 : t.dim, 13)) : avatar(t, e.who, 18))
          .child(v_flex().flex_1().min_w(0).gap(6)
            .child(h_flex().gap(6).text_size(12.5).child(div().text_color(t.foreground).child(e.who ?? "")).child(div().min_w(0).truncate().text_color(t.muted).child(what))
              .child(div().flex_1()).child(div().flex_none().text_color(t.dim).child(ago(e.at))))
            .when(Boolean(e.text?.trim()) && (e.kind === "comment" || e.kind === "review"), (el) => el.child(
              TextView.markdown(`tl-${this.sel.key}-${i}`, e.text).selectable(true).text_size(13).text_color(t.foreground).on_link_click((url, cx) => cx.open_url(url)))));
      }));
  }

  codeView(t) {
    const x = this.diff;
    if (!x || x.loading) return div().p(20).text_size(12.5).text_color(t.dim).child("Loading the diff…");
    if (x.error) return div().p(20).text_size(12.5).text_color(t.ansi1).child(x.error);
    const rows = x.rows;
    const tone = { add: [t.ansi2 + "1f", t.ansi2], del: [t.ansi1 + "1f", t.ansi1], ctx: [null, t.muted], hunk: [null, t.dim] };
    const el = (r) => {
      if (r.t === "file") return h_flex().h(FILE_H).px(20).items_center().font_family(MONO).text_size(12.5).text_color(t.foreground).bg(t.chrome).child(div().truncate().child(r.path));
      const [bg, fg] = tone[r.t];
      return h_flex().h(DIFF_H).px(20).items_center().font_family(MONO).text_size(12).text_color(fg).when(Boolean(bg), (e) => e.bg(bg))
        .child(div().truncate().child(r.text.replace(/\t/g, "    ")));
    };
    return div().relative().flex_1().min_h(0)
      .child(v_virtual_list("prs-diff", rows.length, rows.map((r) => (r.t === "file" ? FILE_H : DIFF_H)), (i) => `d${i}`,
        (range) => rows.slice(range.start, range.end).map(el)).track_scroll(this.dscroll).size_full())
      .child(Scrollbar.vertical("prs-diff").absolute().inset_0());
  }

  render(cx) {
    const t = theme();
    // Coming back to the page: read again if the list is a while old.
    const on = this.shown();
    if (on && !this.wasShown && Date.now() - this.loadedAt > 30000) this.load(cx);
    this.wasShown = on;
    return h_flex().id("onyx-prs").size_full().min_w(0).rounded(8).overflow_hidden().bg(t.background).text_size(13)
      .child(v_flex().w(430).flex_none().h_full().border_r_1().border_color(t.border)
        .child(div().h(44).flex_none().px(20).flex().items_center().text_size(13).font_semibold().text_color(t.foreground).child("Pull requests"))
        .child(h_flex().flex_none().mx(12).mb(8).h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.input ?? t.background)
          .child(ico("search", t.dim, 14)).child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(this.toolbar(t))
        .when(Boolean(this.menu), (el) => el.child(this.menuView(t)))
        .child(this.listView(t)))
      .child(this.detailView(t));
  }
}
