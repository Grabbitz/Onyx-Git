// Onyx quota: every coding agent's plan quota in one slim strip, read through quota-axi
// (https://github.com/kunchenguid/quota-axi, `npm i -g quota-axi`).
//
// One copy, three faces (props().view):
//   none       the strip: icon · slim bar · % per provider, then refresh and settings
//   "overview" a popup of every provider, tightest limit first, every window as a bar
//   "picker"   a popup to switch providers on and off and pick "% used" or "% left"
//
// Only the strip polls (every 2 min, one quota-axi call for all providers); popups read the
// shared snapshot it writes. Colours always follow % used: amber from 80 %, red from 95 %.
import { View, div, svg, image } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { exec, theme, props, shared, setShared, openOverlay, closeOverlay, nextCommand } from "herdr";

const DATA = "onyx-quota.data";  // { [id]: { windows: [{ name, short, used, reset }], error, keychain, missing } }
const ON = "onyx-quota.on";      // provider ids shown in the strip
const MODE = "onyx-quota.mode";  // "used" | "left"
const EVERY = 120000;

// id -> name, Herdr's icon (icons/<file>.svg), tint (one-colour glyph drawn in the text colour).
export const PROVIDERS = [
  ["claude", "Claude", "claude"], ["codex", "Codex", "codex"], ["cursor", "Cursor", "cursor", true],
  ["copilot", "Copilot", "copilot", true], ["agy", "Antigravity", "antigravity"], ["grok", "Grok", "grok", true],
  ["kimi", "Kimi", "kimi"], ["opencode-go", "OpenCode", "opencode", true], ["zai", "Z.AI"], ["deepseek", "DeepSeek"],
  ["minimax", "MiniMax"], ["openrouter", "OpenRouter"],
].map(([id, name, icon, tint]) => ({ id, name, icon, tint: Boolean(tint) }));
const byId = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

// "five_hour" -> "5h", "Gemini weekly" -> "Gem wk": labels short enough for a tooltip line.
export function shortName(id, label) {
  if (id === "five_hour") return "5h";
  if (id === "seven_day" || id === "weekly") return "7d";
  return String(label || id).replace("Claude/GPT", "C/G").replace("Gemini", "Gem")
    .replace(/ ?5-hour/, " 5h").replace(/ weekly$/i, " wk").replace(/^week$/i, "wk").trim();
}

// quota-axi --json -> { [id]: entry }. Product sub-pools (Grok's voice, image...) are left out.
export function parse(json) {
  const out = {};
  for (const p of JSON.parse(json).providers ?? []) {
    const st = p.state ?? {};
    const windows = (p.windows ?? [])
      .filter(w => typeof w.percentRemaining === "number" && !String(w.id).startsWith("product:"))
      .map(w => ({ name: w.label || w.id, short: shortName(w.id, w.label), used: 100 - w.percentRemaining,
        reset: w.resetsAt ? Date.parse(w.resetsAt) : null }));
    const why = String(st.error || st.reason || "");
    out[p.provider] = { windows, missing: Boolean(p.notSetUp), keychain: why.includes("keychain"),
      error: windows.length ? null : (p.notSetUp ? "Not set up" : why.replace(/_/g, " ") || "No quota reported") };
  }
  return out;
}

const tightest = (e) => (e?.windows ?? []).reduce((a, w) => (!a || w.used > a.used ? w : a), null);
const pct = (n) => (n > 0 && n < 1 ? "<1%" : n > 99 && n < 100 ? ">99%" : `${Math.round(n)}%`);
const left = () => shared(MODE) === "left";
const shown = (used) => (left() ? 100 - used : used);
const word = () => (left() ? "left" : "used");
const tone = (used, t) => (used >= 95 ? t.blocked : used >= 80 ? t.ansi3 : null);

function until(ms) {
  if (!ms) return "";
  const m = Math.ceil((ms - Date.now()) / 60000);
  if (m <= 0) return "now";
  const d = Math.floor(m / 1440), h = Math.floor(m / 60) % 24;
  return d ? `${d}d ${h}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function logo(p, size, t) {
  if (!p?.icon) return div().size(size).flex_none().rounded(3).bg(t.border).text_size(size * 0.6)
    .text_color(t.muted).flex().items_center().justify_center().child((p?.name ?? "?")[0]);
  return p.tint ? svg(`icons/${p.icon}.svg`).size(size).flex_none().text_color(t.foreground)
    : image(`icons/${p.icon}.svg`).size(size).flex_none();
}

function bar(used, width, height, t) {
  const v = Math.max(0, Math.min(100, shown(used)));
  return div().w(width).h(height).flex_none().rounded(height).bg(t.border)
    .child(div().h(height).w(v > 0 ? Math.max(2, (width * v) / 100) : 0).rounded(height).bg(tone(used, t) ?? t.accent));
}

// Where node and quota-axi live: Herdr's own PATH often lacks nvm/volta, so ask the login shell once.
let runner = null;
async function findRunner() {
  if (runner) return runner;
  const r = await exec("/bin/sh", ["-c", 'exec "${SHELL:-/bin/zsh}" -lic "command -v node; command -v quota-axi" 2>/dev/null']).catch(() => null);
  const [node, qa] = (r?.stdout ?? "").split("\n").map(s => s.trim()).filter(s => s.startsWith("/"));
  runner = node && qa ? [node, qa] : null;
  return runner;
}

async function read(ids, allowKeychain) {
  const run = await findRunner();
  if (!run) return Object.fromEntries(ids.map(id => [id, { windows: [], error: "quota-axi not found · npm i -g quota-axi" }]));
  const args = [run[1], "--provider", ids.join(","), "--json", "--max-age", "60s"];
  if (allowKeychain) args.push("--allow-keychain-prompt");
  const r = await exec(run[0], args).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
  try { return parse(r.stdout); } catch (_) {
    return Object.fromEntries(ids.map(id => [id, { windows: [], error: "quota-axi failed" }]));
  }
}

export default class OnyxQuota extends View {
  init(_props, cx) {
    this.view = props()?.view ?? null;
    this.busy = false;
    cx.timer.every(60000, cx => cx.notify()); // reset countdowns
    if (this.view) return;
    this.refresh(cx, true);
    cx.timer.every(EVERY, cx => this.refresh(cx));
    cx.spawn(async cx => { for (;;) { if (await nextCommand() === "refresh") this.refresh(cx); } });
  }

  // First run: show whichever providers quota-axi finds set up on this machine.
  refresh(cx, first = false, keychain = null) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      const ids = keychain ? [keychain] : (first && !shared(ON)) ? PROVIDERS.map(p => p.id) : (shared(ON) ?? []);
      if (ids.length) {
        const got = await read(ids, Boolean(keychain));
        setShared(DATA, { ...(shared(DATA) ?? {}), ...got });
        if (!shared(ON)) setShared(ON, PROVIDERS.filter(p => got[p.id] && !got[p.id].missing).map(p => p.id));
      }
      this.busy = false;
      cx.notify();
    });
  }

  chip(id, t) {
    const p = byId[id], e = shared(DATA)?.[id], top = tightest(e);
    const tip = `${p.name} — ${!e ? "loading" : e.error ?? e.windows.map(w => `${w.name} ${pct(shown(w.used))} ${word()}${w.reset ? ` · resets ${until(w.reset)}` : ""}`).join("\n")}`;
    const el = Button.new(`q-${id}`).h_flex().items_center().gap(5).h(22).px(6).rounded(6).flex_shrink_0()
      .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(tip).accessibility_label(tip)
      .on_click(() => openOverlay({ mod: "onyx-quota", props: { view: "overview" }, kind: "popup", width: 400,
        height: 76 + (shared(ON) ?? []).length * 74 }))
      .child(logo(p, 12, t));
    if (!e) return el.child(div().w(52).text_color(t.dim).child("·"));
    if (!top) return el.child(div().size(5).rounded_full().bg(t.ansi3));
    return el.child(bar(top.used, 24, 3, t))
      .child(div().w(28).text_size(11).text_color(tone(top.used, t) ?? t.muted).child(pct(shown(top.used))));
  }

  strip() {
    const t = theme();
    const on = shared(ON) ?? [];
    const ctl = (id, icon, label, action) => Button.new(id).size(22).flex_shrink_0().rounded(6).cursor_pointer()
      .flex().items_center().justify_center().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label).accessibility_label(label).on_click(action).child(svg(`mods/onyx-quota/${icon}.svg`).size(13));
    return h_flex().id("onyx-quota").size_full().items_center().justify_end().pr(10).gap(10).bg(t.chrome).text_size(11)
      .child(h_flex().items_center().gap(2).min_w(0).overflow_x_scroll().children(on.map(id => this.chip(id, t)))
        .when(on.length === 0, el => el.child(div().px(6).text_color(t.dim).child(shared(ON) ? "No providers" : "Reading quota…"))))
      .child(div().w(1).h(12).flex_none().bg(t.border))
      .child(h_flex().items_center().gap(2).flex_none()
        .child(ctl("q-refresh", "refresh", this.busy ? "Reading…" : "Refresh · every 2 min", (_e, cx) => this.refresh(cx))
          .when(this.busy, el => el.opacity(0.5)))
        .child(ctl("q-picker", "sliders", "Providers", () => openOverlay({ mod: "onyx-quota", props: { view: "picker" },
          kind: "popup", width: 280, height: 64 + PROVIDERS.length * 36 }))));
  }

  overview() {
    const t = theme();
    const data = shared(DATA) ?? {};
    const ids = [...(shared(ON) ?? [])].sort((a, b) => (tightest(data[b])?.used ?? -1) - (tightest(data[a])?.used ?? -1));
    const row = (id) => {
      const p = byId[id], e = data[id];
      const next = (e?.windows ?? []).map(w => w.reset).filter(Boolean).sort((a, b) => a - b)[0];
      return v_flex().w_full().gap(6).p(10).rounded(8).bg(t.surface)
        .child(h_flex().w_full().items_center().gap(8)
          .child(logo(p, 15, t)).child(div().font_semibold().child(p.name)).child(div().flex_1())
          .when(Boolean(next), el => el.child(div().text_size(11).text_color(t.dim).child(`resets in ${until(next)}`))))
        .when(Boolean(e?.error), el => el.child(h_flex().w_full().items_center().gap(8)
          .child(div().flex_1().text_size(11.5).text_color(t.ansi3).child(e.error))
          .when(Boolean(e?.keychain), el => el.child(Button.new(`allow-${id}`).h(22).px(8).rounded(6).cursor_pointer()
            .bg(t.raised).hover(s => s.bg(t.hover)).text_size(11).child("Allow Keychain")
            .tooltip("Asks macOS once; choose Always Allow").on_click((_e, cx) => this.refresh(cx, false, id))))))
        .children((e?.windows ?? []).map(w => h_flex().w_full().items_center().gap(8)
          .child(div().w(110).flex_none().truncate().text_size(11.5).text_color(t.muted).child(w.name))
          .child(bar(w.used, 170, 5, t)).child(div().flex_1())
          .child(div().text_size(11.5).font_semibold().text_color(tone(w.used, t) ?? t.foreground).child(pct(shown(w.used))))));
    };
    return v_flex().id("q-overview").size_full().p(12).gap(8).bg(t.chrome).text_size(12).text_color(t.foreground).overflow_y_scrollbar()
      .child(h_flex().items_center().px(2)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("QUOTA"))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child(`% ${word()}`)))
      .children(ids.map(row));
  }

  picker() {
    const t = theme();
    const on = shared(ON) ?? [], data = shared(DATA) ?? {};
    const toggle = (v) => div().w(26).h(15).flex_none().rounded(8).p(2).flex().items_center()
      .bg(v ? t.accent : t.border).when(v, el => el.justify_end()).child(div().size(11).rounded_full().bg(v ? t.accent_foreground : t.muted));
    const seg = (id, label) => {
      const v = (shared(MODE) ?? "used") === id;
      return Button.new(`mode-${id}`).h(20).px(8).rounded(5).cursor_pointer().text_size(11).flex().items_center()
        .bg(v ? t.raised : t.surface).text_color(v ? t.foreground : t.dim).hover(s => s.text_color(t.foreground))
        .child(label).on_click((_e, cx) => { setShared(MODE, id); cx.notify(); });
    };
    const row = (p) => {
      const v = on.includes(p.id), e = data[p.id], top = tightest(e);
      return Button.new(`pick-${p.id}`).h_flex().items_center().justify_start().gap(10).w_full().h(32).px(10).rounded(7)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .child(div().opacity(v ? 1 : 0.45).child(logo(p, 15, t)))
        .child(div().text_size(12.5).text_color(v ? t.foreground : t.muted).child(p.name))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(e?.missing ? "not set up" : top ? pct(shown(top.used)) : ""))
        .child(toggle(v))
        .on_click((_e, cx) => {
          const next = v ? on.filter(x => x !== p.id) : [...on, p.id];
          setShared(ON, PROVIDERS.map(x => x.id).filter(x => next.includes(x)));
          if (!v) this.refresh(cx);
          cx.notify();
        });
    };
    return v_flex().size_full().p(8).gap(1).bg(t.chrome).text_color(t.foreground).overflow_y_scrollbar()
      .child(h_flex().items_center().px(10).pt(4).pb(8)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("PROVIDERS")).child(div().flex_1())
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.surface).child(seg("used", "Used")).child(seg("left", "Left"))))
      .children(PROVIDERS.map(row));
  }

  render() {
    if (this.view === "overview") return this.overview();
    if (this.view === "picker") return this.picker();
    return this.strip();
  }
}
