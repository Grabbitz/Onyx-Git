// Left half of herdr-t3's bottom strip: the focused pane's git (folder · branch ↑↓ · changed files),
// then agents at work (count + how long the longest has been working) and agents that need you.
// Shown only when there is something to say; quota lives in onyx-quota on the right.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, spaces, agents, focused, run, theme, home } from "herdr";

// 42s, 3:07, 1:02:09
function elapsed(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : m ? `${m}:${pad(s % 60)}` : `${s}s`;
}

// "/Users/me/DevOps/Collab/planogram2" -> "Collab/planogram2"; home -> "~"
function shortPath(p) {
  if (!p) return "";
  const h = home();
  if (p === h) return "~";
  const parts = (p.startsWith(h) ? p.slice(h.length) : p).split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

// git status --porcelain=v2 --branch -> { branch, ahead, behind, changed }
export function parseStatus(out) {
  const g = { branch: null, ahead: 0, behind: 0, changed: 0 };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) g.branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      g.ahead = Math.abs(parseInt(a, 10)) || 0; g.behind = Math.abs(parseInt(b, 10)) || 0;
    } else if (line && !line.startsWith("#")) g.changed++;
  }
  return g;
}

export default class StatusLeft extends View {
  init(_props, cx) {
    this.git = null; // { cwd, branch, ahead, behind, changed } or null outside a repo
    this.cwd = undefined;
    // Git can change without Herdr knowing (a commit in the shell): look again every 5 s.
    // The clock only needs a redraw while something is working.
    cx.timer.every(5000, cx => this.look(cx, true));
    cx.timer.every(1000, cx => { if (spaces().some(s => s.tabs.some(t => t.working_since))) cx.notify(); });
  }

  look(cx, force = false) {
    const f = focused(), cwd = f?.cwd ?? null;
    if (!force && cwd === this.cwd) return;
    this.cwd = cwd;
    if (!cwd) { this.git = null; return; }
    const on = spaces().find(s => s.id === f.space)?.machine ?? undefined;
    cx.spawn(async cx => {
      const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], { cwd, on }).catch(() => null);
      if (this.cwd !== cwd) return; // focus moved on meanwhile
      this.git = r && r.code === 0 ? { cwd, ...parseStatus(r.stdout) } : null;
      cx.notify();
    });
  }

  render(cx) {
    this.look(cx); // re-reads git when the focused folder changes
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const g = this.git;
    const working = spaces().flatMap(s => s.tabs).filter(tab => tab.working_since);
    const longest = working.reduce((a, tab) => (!a || tab.working_since < a.working_since ? tab : a), null);
    const list = agents();
    const blocked = list.filter(a => a.status === "blocked");
    const busy = list.filter(a => a.status === "working");
    const done = list.filter(a => a.status === "done");   // finished while you weren't looking
    const idle = list.filter(a => a.status === "idle");
    const sep = () => div().w(1).h(12).flex_none().bg(t.border);

    const gitPart = g && h_flex().id("sl-git").items_center().gap(6).min_w(0).flex_shrink(1)
      .tooltip(`${g.cwd}\n${g.branch ?? "detached"}${g.ahead ? ` · ${g.ahead} ahead` : ""}${g.behind ? ` · ${g.behind} behind` : ""} · ${g.changed} changed`)
      .child(div().min_w(0).truncate().text_color(t.muted).child(shortPath(g.cwd)))
      .child(svg("mods/onyx-status/branch.svg").size(11).flex_none().text_color(t.dim))
      .child(div().flex_none().text_color(t.muted).child(g.branch ?? "detached"))
      .when(g.ahead > 0, el => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, el => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)))
      .when(g.changed > 0, el => el.child(h_flex().flex_none().items_center().gap(4)
        .child(div().size(5).rounded_full().bg(t.ansi3)).child(div().text_color(t.muted).child(`${g.changed}`))));

    // Click: go to the agent that needs you, else the one working longest.
    const go = () => {
      const target = blocked[0] ?? busy.find(a => a.tab === longest?.id) ?? busy[0] ?? done[0] ?? idle[0];
      if (target) run("agent.focus", { terminal: target.address });
    };
    const names = list.map(a => `${a.status} · ${a.program?.name ?? a.app ?? "agent"} · ${a.space_name}`).join("\n");
    const agentPart = list.length > 0 && h_flex().id("sl-agents").items_center().gap(8).flex_none()
      .px(6).h(22).rounded(6).cursor_pointer().hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(go)
      .tooltip(names || "Agents")
      .when(busy.length > 0, el => el.child(h_flex().items_center().gap(5)
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900))
        .child(div().text_color(t.muted).child(`${busy.length} working`))
        .when(Boolean(longest), el => el.child(div().text_color(t.dim).child(elapsed(longest.working_since))))))
      .when(blocked.length > 0, el => el.child(h_flex().items_center().gap(5)
        .child(div().size(14).rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked)
          .flex().items_center().justify_center().child("!"))
        .child(div().text_color(t.blocked).child(`${blocked.length} need${blocked.length === 1 ? "s" : ""} you`))))
      .when(done.length > 0, el => el.child(h_flex().items_center().gap(5)
        .child(div().size(6).rounded_full().bg(t.done)).child(div().text_color(t.muted).child(`${done.length} done`))))
      .when(idle.length > 0, el => el.child(h_flex().items_center().gap(5)
        .child(div().size(7).rounded_full().border_1().border_color(t.dim)).child(div().text_color(t.dim).child(`${idle.length} idle`))));

    return h_flex().id("onyx-status").size_full().min_w(0).items_center().pl(12).pr(6).gap(10)
      .bg(t.chrome).text_size(11)
      .when(Boolean(gitPart), el => el.child(gitPart))
      .when(Boolean(gitPart) && Boolean(agentPart), el => el.child(sep()))
      .when(Boolean(agentPart), el => el.child(agentPart));
  }
}
