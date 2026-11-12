// Claude panel: which account new Claude sessions use (cvp profiles), Claude versions (cvm),
// per-folder pins, usage per account, agent-router / keepalive options and updates.
// Everything goes through ./ctl.py, which answers in JSON and never prints a secret.
// Personal settings (names, usage, setup state) live in ~/.cvm/herdr/pond-profiles.json, not in this folder.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, home, appHome, terminals, panes, spaces, focused, theme, run, notify, nextCommand, setShared, writeTextFile } from "herdr";
import { keybar, keysCard } from "./keybar.js";
import { setupView, loadDoctor, openProfileForm, profileForm, openLabelForm, labelForm, openUsageForm, usageForm } from "./setup.js";

const MOD = "pond-profiles", ME = `mods/${MOD}`, CHROME = "mods/workspace-chrome";
const CTL = () => `${appHome()}/${ME}/ctl.py`;
const UPDATE_EVERY = 6 * 3600 * 1000;
const USAGE_EVERY = 2 * 60 * 1000;
const tilde = p => p && p.startsWith(home()) ? "~" + p.slice(home().length) : p;
const host = url => url ? url.replace(/^https?:\/\//, "").split("/")[0] : "";
const titled = s => s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : "?";
const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const newer = (a, b) => { // a > b, semver-ish
  const p = v => String(v).split(/[.\-+]/).map(x => Number.parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const fmt = n => n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function resets(iso) {
  const at = new Date(Math.round(new Date(iso).getTime() / 60000) * 60000), ms = at.getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Resetting…";
  const min = Math.round(ms / 60000);
  if (min < 60) return `Resets in ${min} min`;
  if (min < 24 * 60) return `Resets in ${Math.floor(min / 60)} h ${min % 60} min`;
  const h = at.getHours(), m = String(at.getMinutes()).padStart(2, "0");
  return `Resets ${MONTHS[at.getMonth()]} ${at.getDate()}, ${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

const ROLES = [
  ["scout", "Scout", "read-only discovery"], ["reviewer", "Reviewer", "code review"],
  ["security_reviewer", "Security", "vulnerability review"], ["task", "Task", "delegated work, Plan"],
  ["sonic", "Sonic", "mechanical edits"], ["teammate", "Teammates", "overrides every teammate"],
];
const SECTIONS = ["account", "usage", "folder", "versions", "updates", "router"];

const KEYS = {
  panel: [
    { caps: ["p"], label: "switch account" }, { caps: ["u"], label: "check updates" },
    { caps: ["j", "k"], label: "next / prev section" }, { caps: ["r"], label: "refresh" }, { caps: ["q"], label: "close the panel" },
  ],
  input: [{ caps: ["enter"], label: "save" }, { caps: ["escape"], label: "cancel" }],
};

function keyOf(e) {
  const m = e.modifiers ?? {};
  if (m.control || m.platform || m.alt) return e.keystroke;
  if (["enter", "escape", "tab", "space", "up", "down", "left", "right", "backspace"].includes(e.key)) return e.key;
  return e.key_char ?? e.key;
}

function location() {
  const f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || spaces().find(s => s.active)?.folder || home();
}

// Live Claude terminals with the account the launch hook labelled them with (null from before it).
function claudeAgents() {
  return terminals().filter(x => x.state === "live" && !x.address.includes("/") &&
    (x.foreground?.name === "claude" || x.report?.app === "claude-code" || x.agent === "claude-code"))
    .map(x => ({ address: x.address, where: x.labels?.where || x.title || x.address,
      profile: x.labels?.["herdr.claude-profile"] ?? null, version: x.labels?.["herdr.claude-version"] ?? null }));
}

async function ctl(args, timeout = 30000) {
  try {
    const r = await exec("python3", [CTL(), ...args], { timeout });
    const json = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
    return json.ok === undefined ? { ok: false, error: r.stderr || "No answer" } : json;
  } catch (e) { return { ok: false, error: String(e) }; }
}

export default class Claude extends View {
  init(_props, cx) {
    this.st = null; this.err = null; this.busy = {}; this.errors = {};
    this.remote = JSON.parse(localStorage.getItem("remote") ?? "null"); // {latest, errors, at}
    this.router = null; this.models = null; this.picking = null; this.keyEdit = null;
    this.form = null; this.manage = false; this.removing = null; this.varEdit = null;
    this.setupShown = false; this.doctor = null;
    this.sel = 0; this.scroll = ScrollHandle.new(); this.handle = cx.focus_handle();
    this.usage = {}; // profile -> {result, at}
    this.signin = null; // {profile, code, url, until, status}
    this.refresh(cx);
    cx.timer.every(USAGE_EVERY, cx => this.loadUsage(cx));
    cx.timer.every(5000, cx => this.refresh(cx));
    cx.timer.every(30 * 60 * 1000, cx => { if (Date.now() - (this.remote?.at ?? 0) > UPDATE_EVERY) this.checkUpdates(cx); });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") {
          const token = this.focusToken = (this.focusToken ?? 0) + 1;
          this.handle.focus();
          cx.timer.after(40, () => { if (this.handle.is_focused()) this.focusToken++; });
          cx.timer.after(150, cx => { if (this.focusToken === token && !this.handle.is_focused()) { this.handle.focus(); cx.notify(); } });
        }
        else if (c.startsWith("key:")) this.press(c.slice(4), cx);
        else if (c.startsWith("go:")) this.go(c.slice(3));
        else if (c === "switch") this.cycleAccount(cx);
        else if (c === "updates") this.checkUpdates(cx);
        else if (c === "setup") this.openSetup(cx);
        else if (c === "add-profile") openProfileForm(this, cx);
        else if (c === "finish") this.closeSetup(cx);
        cx.notify();
      }
    });
    cx.timer.every(300, cx => {
      const k = this.handle.is_focused();
      if (k !== this.sharedKeys) { this.sharedKeys = k; setShared(`${MOD}.hasKeys`, k); }
      if (k !== this.hadKeys) { this.hadKeys = k; cx.notify(); }
    });
  }

  ctl(args, timeout) { return ctl(args, timeout); }

  label(name) { return this.st?.profiles.find(p => p.name === name)?.label ?? titled(name); }

  // ---- Data -------------------------------------------------------------------

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    const where = location();
    cx.spawn(async cx => {
      const r = await ctl(["status", where]);
      this.refreshing = false;
      if (r.ok) {
        const first = !this.st;
        this.st = { ...r, where }; this.err = null;
        if (first) {
          if (!r.setup.done || !r.setup.basics) this.openSetup(cx);
          else this.startPanel(cx);
        }
        if (r.cvm.installed && !r.hook && !this.hookTried) { this.hookTried = true; await ctl(["install-hook"]); }
        setShared(`${MOD}.account`, r.active);
      } else this.err = r.error;
      cx.notify();
    });
  }

  startPanel(cx) {
    this.loadUsage(cx);
    this.loadRouter(cx);
    if (!this.remote || Date.now() - this.remote.at > UPDATE_EVERY) this.checkUpdates(cx);
  }

  closeSetup(cx) {
    if (!this.setupShown || !this.st?.setup?.basics) return;
    this.act("setup-finish", "…", ["setup", "done"], cx, { then: (_r, cx) => { this.setupShown = false; this.form = null; this.startPanel(cx); } });
  }

  openSetup(cx) {
    this.setupShown = true; this.form = null;
    loadDoctor(this, cx);
    cx.spawn(async cx => { await ctl(["setup", "reopen"]); });
    cx.notify();
  }

  loadUsage(cx) {
    if (this.setupShown) return;
    for (const p of (this.st?.profiles ?? []).filter(p => p.usage)) this.loadUsageOne(p.name, cx, false);
  }

  // clear: show Loading… while it runs (a Retry), rather than keeping the last result.
  loadUsageOne(name, cx, clear = true) {
    if (clear) { delete this.usage[name]; cx.notify(); }
    cx.spawn(async cx => {
      const r = await ctl(["usage", name], 70000);
      this.usage[name] = { result: r, at: Date.now() };
      cx.notify();
    });
  }

  // Gateway device sign-in: ctl gets a code, the browser approves it, polling picks up the token.
  startSignin(profile, cx) {
    this.signin = { profile, status: "starting" }; cx.notify();
    cx.spawn(async cx => {
      const r = await ctl(["gateway-login", profile]);
      if (!r.ok) { this.signin = { profile, status: "failed", error: r.error }; cx.notify(); return; }
      this.signin = { profile, status: "waiting", code: r.userCode, url: r.url, until: Date.now() + (r.expiresIn ?? 600) * 1000, interval: r.interval ?? 5 };
      exec("open", [r.url]);
      cx.notify();
      this.pollSignin(cx);
    });
  }

  pollSignin(cx) {
    const s = this.signin;
    if (!s || s.status !== "waiting") return;
    cx.timer.after(s.interval * 1000, cx => cx.spawn(async cx => {
      if (this.signin !== s) return;
      const r = await ctl(["gateway-poll", s.profile]);
      if (this.signin !== s) return;
      if (r.ok && r.status === "pending") { if (r.slowDown) s.interval += 5; this.pollSignin(cx); return; }
      if (r.ok && r.status === "done") {
        this.signin = null;
        notify({ title: `Signed in to ${this.label(s.profile)}`, level: "success", timeout: 3000 });
        this.loadUsage(cx);
      } else this.signin = { profile: s.profile, status: "failed", error: r.ok ? (r.status === "denied" ? "Sign-in was denied." : r.status === "expired" ? "The code expired: try again." : r.error || "Sign-in failed.") : r.error };
      cx.notify();
    }));
  }

  signOut(profile, cx) {
    cx.spawn(async cx => { await ctl(["gateway-logout", profile]); this.loadUsage(cx); });
  }

  loadRouter(cx) {
    cx.spawn(async cx => { const r = await ctl(["router"], 60000); this.router = r; cx.notify(); });
  }

  checkUpdates(cx) {
    if (this.busy.check) return;
    this.busy.check = "Checking…"; cx.notify();
    cx.spawn(async cx => {
      const r = await ctl(["remote"], 40000);
      delete this.busy.check;
      if (r.ok) { this.remote = { latest: r.latest, errors: r.errors, at: Date.now() }; localStorage.setItem("remote", JSON.stringify(this.remote)); }
      else this.errors.updates = r.error;
      const avail = this.updates().filter(u => u.available);
      if (avail.length && avail.length !== this.notifiedUpdates) notify({ title: `Claude: ${avail.length} update${avail.length > 1 ? "s" : ""} available`, body: avail.map(u => `${u.label} ${u.latest}`).join(", "), level: "info", timeout: 6000 });
      this.notifiedUpdates = avail.length;
      cx.notify();
    });
  }

  // Runs a ctl command for `key`, with a spinner on it, a toast when asked, and a refresh.
  act(key, label, args, cx, { toast, timeout = 600000, then } = {}) {
    if (this.busy[key]) return;
    this.busy[key] = label; delete this.errors[key]; cx.notify();
    cx.spawn(async cx => {
      const r = await ctl(args, timeout);
      delete this.busy[key];
      if (!r.ok) { this.errors[key] = r.error; if (toast) notify({ title: `${toast} failed`, body: r.error, level: "error" }); }
      else { if (toast) notify({ title: toast, level: "success", timeout: 4000 }); then?.(r, cx); }
      this.refresh(cx);
      cx.notify();
    });
  }

  updates() {
    const st = this.st, l = this.remote?.latest ?? {};
    if (!st) return [];
    const rows = [
      { id: "claude", label: "Claude Code", have: st.claude.global, latest: l.claude },
      { id: "cvm", label: "cvm", have: st.cvm.version, latest: l.cvm },
      { id: "cvp", label: "cvp profiles", have: st.cvp.version, latest: l.cvp },
      { id: "agent-router", label: "Agent Router", have: st.plugins["agent-router"]?.version, latest: l["agent-router"], optional: true },
      { id: "keepalive", label: "Keepalive", have: st.plugins.keepalive?.version, latest: l.keepalive, optional: true },
    ].filter(r => !r.optional || r.have);
    return rows.map(r => ({ ...r, available: Boolean(r.have && r.latest && newer(r.latest, r.have)) }));
  }

  // ---- Actions ----------------------------------------------------------------

  // Running sessions aren't touched (ctl keeps cvp out of ~/.claude/settings.json), so no confirm.
  switchAccount(name, cx) {
    const st = this.st;
    if (!st || name === st.active) return;
    this.act("account", "Switching…", ["use", name], cx, {
      then: () => notify({ title: `Claude: ${this.label(name)}`, body: "New Claude sessions use this account; running ones keep theirs.", level: "success", timeout: 3500 }),
    });
  }

  cycleAccount(cx) {
    const names = this.st?.profiles.map(p => p.name) ?? [];
    if (names.length < 2) return;
    this.switchAccount(names[(names.indexOf(this.st.active) + 1) % names.length], cx);
  }

  pinDir() { return this.st.local?.dir ?? this.st.root ?? this.st.where; }

  pinProfile(name, cx) { this.act("pinProfile", "Saving…", ["pin-profile", this.pinDir(), name], cx); }

  pinVersion(v, cx) { this.act("pinVersion", "Saving…", ["pin-version", this.st.claude.local?.dir ?? this.st.root ?? this.st.where, v], cx); }

  openKey(profile, cx) {
    const input = InputState.new({ placeholder: `Paste the ${this.label(profile)} key` });
    input.set_masked(true);
    input.on("submit", (_e, cx) => this.saveKey(cx));
    this.keyEdit = { profile, input };
    input.focus();
    cx.notify();
  }

  // One profile variable: v = { k, v, secret } to edit, or null to add one.
  openVar(profile, v, cx) {
    const name = InputState.new({ placeholder: "VARIABLE_NAME" });
    const value = InputState.new({ placeholder: v?.secret ? "Paste a new value (the current one stays hidden)" : "value" });
    if (v) name.set_value(v.k);
    if (v && !v.secret) value.set_value(v.v ?? "");
    if (v?.secret) value.set_masked(true);
    name.on("submit", (_e, cx) => this.saveVar(cx));
    value.on("submit", (_e, cx) => this.saveVar(cx));
    this.varEdit = { profile, old: v?.k ?? null, secret: Boolean(v?.secret), name, value };
    this.keyEdit = null;
    (v ? value : name).focus();
    cx.notify();
  }

  saveVar(cx, remove = false) {
    const e = this.varEdit;
    if (!e) return;
    const name = e.name.value().trim(), value = e.value.value().trim();
    if (!remove && !name) return;
    // A secret left empty keeps its value: only a rename needs saving then, and that needs the value.
    if (!remove && e.secret && !value) { if (name === e.old) { this.varEdit = null; this.handle.focus(); cx.notify(); } return; }
    this.varEdit = null; this.handle.focus();
    const spec = remove ? { name: e.old, value: null } : { name, value, old: e.old };
    const tmp = `${appHome()}/${ME}/.handoff-${Math.random().toString(36).slice(2)}`;
    cx.spawn(async cx => {
      try { await writeTextFile(tmp, JSON.stringify(spec), null); } catch (err) { this.errors.vars = String(err); cx.notify(); return; }
      this.act("vars", "Saving…", ["profile-var", e.profile, tmp], cx,
        { toast: remove ? `${e.old} removed from ${this.label(e.profile)}` : `${name} saved in ${this.label(e.profile)}` });
    });
  }

  varRows(p, t) {
    const e = this.varEdit?.profile === p.name ? this.varEdit : null;
    const field = (input, w, masked) => Input.new(input).h(26).px(7).rounded(6).border_1().border_color(t.accent).bg(t.background)
      .font_family("JetBrains Mono").text_size(11.5).when(Boolean(w), el => el.w(w).flex_none()).when(!w, el => el.flex_1().min_w(0));
    const editor = () => v_flex().gap(6).p(8).rounded(6).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).child(field(e.name, 190)).child(field(e.value)))
      .when(e.secret, el => el.child(div().text_size(10.5).text_color(t.dim).child("Hidden value: leave it empty to keep the current one.")))
      .child(h_flex().gap(6)
        .child(this.button("var-save", "Save", "primary", cx => this.saveVar(cx), t))
        .when(Boolean(e.old), el => el.child(this.button("var-remove", "Remove", "danger", cx => this.saveVar(cx, true), t)))
        .child(this.button("var-cancel", "Cancel", null, cx => { this.varEdit = null; this.handle.focus(); cx.notify(); }, t)));
    const rows = (p.env ?? []).map(v => e?.old === v.k ? editor()
      : h_flex().id(`var-${p.name}-${v.k}`).h(22).px(6).gap(8).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(`${v.k}=${v.secret ? "*****" : v.v} · click to edit`)
        .on_click((ev, cx) => { cx.stop_propagation(); this.openVar(p.name, v, cx); })
        .child(div().w(250).flex_none().truncate().font_family("JetBrains Mono").text_size(11).text_color(t.muted).child(v.k))
        .child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(11).text_color(v.secret ? t.dim : t.foreground).child(v.secret ? "*****" : v.v)));
    if (e && !e.old) rows.push(editor());
    else rows.push(h_flex().pl(6).pt(2).child(this.link(`var-add-${p.name}`, "+ Add variable", cx => this.openVar(p.name, null, cx), t, t.accent)));
    return v_flex().ml(14).p(4).gap(1).rounded(6).bg(t.surface).children(rows);
  }

  saveKey(cx) {
    const edit = this.keyEdit, key = edit?.input.value().trim();
    if (!key) return;
    this.keyEdit = null; this.handle.focus();
    const tmp = `${appHome()}/${ME}/.handoff-${Math.random().toString(36).slice(2)}`;
    this.busy.key = "Saving key…"; cx.notify();
    cx.spawn(async cx => {
      try { await writeTextFile(tmp, key, null); } catch (e) { delete this.busy.key; this.errors.key = String(e); cx.notify(); return; }
      delete this.busy.key;
      this.act("key", "Saving key…", ["set-key", edit.profile, tmp], cx, { toast: `${this.label(edit.profile)} key saved` });
    });
  }

  removeProfile(p, cx) {
    if (this.removing !== p.name) { this.removing = p.name; cx.notify(); return; }
    this.removing = null;
    this.act(`rm-${p.name}`, "Removing…", ["profile-remove", p.name], cx, { toast: `${p.label} removed` });
  }

  update(u, cx) {
    this.act(`up-${u.id}`, "Updating…", ["update", u.id], cx, {
      toast: `${u.label} updated`,
      then: (_r, cx) => { this.remote = { ...this.remote, at: 0 }; this.checkUpdates(cx); if (u.id === "agent-router" || u.id === "keepalive") this.loadRouter(cx); },
    });
  }

  gatewayProfile() {
    const st = this.st;
    const active = st?.profiles.find(p => p.name === st.active);
    return active?.gateway ? active : st?.profiles.find(p => p.gateway && p.hasKey) ?? null;
  }

  pickModel(role, cx) {
    if (this.picking === role) { this.picking = null; cx.notify(); return; }
    this.picking = role; cx.notify();
    const gw = this.gatewayProfile();
    if (this.models || !gw) return;
    cx.spawn(async cx => {
      const r = await ctl(["models", gw.name]);
      this.models = r.ok ? r.models : { error: r.error };
      cx.notify();
    });
  }

  setOption(plugin, key, value, cx) {
    const store = plugin === "agent-router" ? this.router?.agent_router : this.router?.keepalive;
    if (store?.values) store.values[key] = value; // shows at once; reloaded after
    this.picking = null;
    this.act(`opt-${key}`, "Saving…", ["router-set", plugin, JSON.stringify({ [key]: value })], cx, { timeout: 60000, then: (_r, cx) => this.loadRouter(cx) });
  }

  // ---- Keys -------------------------------------------------------------------

  go(dir) {
    this.focusToken = (this.focusToken ?? 0) + 1;
    const pane = focused()?.pane;
    if (dir === "left" && pane) return run("pane.focus", { pane });
    this.handle.focus();
    run("pane.go", { direction: dir });
  }

  navKey(e, cx) {
    const m = e.modifiers ?? {};
    if (!(m.platform && m.alt && !m.control && ["left", "right", "up", "down"].includes(e.key))) return false;
    cx.stop_propagation(); this.go(e.key); return true;
  }

  key(e, cx) { if (this.navKey(e, cx)) return; if (this.press(keyOf(e), cx)) cx.stop_propagation(); }

  press(k, cx) {
    if (this.keysOpen) { if (k === "escape" || k === "?" || k === "q") this.keysOpen = false; cx.notify(); return true; }
    if (this.keyEdit || this.form || this.varEdit) {
      if (k === "escape") { this.keyEdit = null; this.form = null; this.varEdit = null; this.handle.focus(); cx.notify(); return true; }
      return false; // the inputs type
    }
    if (this.setupShown) {
      if (k === "escape" && focused()?.pane) { run("pane.focus", { pane: focused().pane }); return true; }
      if (k === "q") { run("layout.hide", { id: "panel" }); return true; }
      return false;
    }
    const moveTo = i => { this.sel = Math.max(0, Math.min(SECTIONS.length - 1, i)); this.scroll.scroll_to_item(this.sel); cx.notify(); };
    switch (k) {
      case "?": this.keysOpen = true; cx.notify(); return true;
      case "escape":
        if (this.picking || this.removing) { this.picking = null; this.removing = null; cx.notify(); return true; }
        if (focused()?.pane) run("pane.focus", { pane: focused().pane });
        return true;
      case "j": case "down": moveTo(this.sel + 1); return true;
      case "k": case "up": moveTo(this.sel - 1); return true;
      case "g": moveTo(0); return true;
      case "G": moveTo(SECTIONS.length - 1); return true;
      case "p": this.cycleAccount(cx); return true;
      case "u": this.checkUpdates(cx); return true;
      case "r": this.refresh(cx); this.loadRouter(cx); this.loadUsage(cx); return true;
      case "q":
        run("layout.hide", { id: "panel" });
        if (focused()?.pane) run("pane.focus", { pane: focused().pane });
        return true;
    }
    return false;
  }

  // ---- Rendering ----------------------------------------------------------------

  button(id, text, kind, action, t, { disabled, busy } = {}) {
    const primary = kind === "primary", danger = kind === "danger";
    return h_flex().id(id).h(26).px(10).gap(5).flex_none().items_center().rounded(6).text_size(12).font_medium()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .when(Boolean(disabled || busy), el => el.opacity(0.5))
      .when(!disabled && !busy, el => el.cursor_pointer().hover(s => s.opacity(0.88)).on_click((e, cx) => { cx.stop_propagation(); action(cx); }))
      .when(Boolean(busy), el => el.child(svg(`${CHROME}/spinner.svg`).size(11).spin(900)))
      .child(busy || text);
  }

  link(id, text, action, t, color) {
    return div().id(id).flex_none().text_size(11).text_color(color ?? t.dim).cursor_pointer().hover(s => s.text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
  }

  chip(id, text, on, action, t, color) {
    return div().id(id).h(24).px(9).flex_none().flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(on ? color ?? t.accent : t.border).bg(on ? t.selected : t.background)
      .text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
  }

  card(i, title, sub, t, body, right) {
    const on = this.sel === i;
    return v_flex().id(`sec-${SECTIONS[i]}`).flex_none().p(12).gap(10).rounded(10).bg(t.surface).border_1()
      .border_color(on && this.hadKeys ? t.accent : t.border)
      .on_click((_e, cx) => { this.sel = i; cx.notify(); })
      .child(h_flex().gap(8).items_start()
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().font_semibold().child(title)).when(Boolean(sub), el => el.child(div().text_size(11.5).text_color(t.dim).child(sub))))
        .when(Boolean(right), el => el.child(right)))
      .children(body);
  }

  note(text, t, color) { return div().text_size(11.5).text_color(color ?? t.dim).child(text); }

  errorOf(key, t) { return this.errors[key] ? [div().text_size(11.5).text_color(t.ansi1).child(this.errors[key])] : []; }

  accountColor(p, t) { return p?.gateway ? t.ansi5 : t.ansi4; }

  accountCard(t) {
    const st = this.st, agents = claudeAgents();
    const byProfile = {};
    for (const a of agents) byProfile[a.profile ?? "?"] = (byProfile[a.profile ?? "?"] ?? 0) + 1;
    const tile = p => {
      const on = p.name === st.active, color = this.accountColor(p, t);
      return v_flex().id(`acct-${p.name}`).flex_1().min_w(120).p(10).gap(3).rounded(8).border_1()
        .border_color(on ? color : t.border).bg(on ? t.selected : t.background)
        .when(!on, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
        .on_click((e, cx) => { cx.stop_propagation(); this.switchAccount(p.name, cx); })
        .child(h_flex().gap(6).items_center()
          .child(div().size(8).flex_none().rounded_full().bg(on ? color : t.border))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(p.label))
          .when(on && Boolean(this.busy.account), el => el.child(svg(`${CHROME}/spinner.svg`).size(11).spin(900))))
        .child(div().pl(14).text_size(11).text_color(t.dim).truncate().child(p.gateway ? host(p.gateway) : "claude.ai login"))
        .when(Boolean(p.gateway) && !p.hasKey, el => el.child(div().pl(14).text_size(11).text_color(t.ansi1).child("no key")));
    };
    const body = [h_flex().gap(8).flex_wrap().children(st.profiles.map(tile))];
    if (!st.profiles.length) body.push(this.note("No profiles yet: add one below, or run setup again from ⚙.", t, t.ansi3));
    if (agents.length) {
      body.push(h_flex().gap(10).flex_wrap().text_size(11.5).text_color(t.dim)
        .child("Running:")
        .children(Object.entries(byProfile).map(([name, n]) => h_flex().gap(4).items_center()
          .child(div().size(6).rounded_full().bg(this.accountColor(st.profiles.find(p => p.name === name), t)))
          .child(`${n} on ${name === "?" ? "unknown" : this.label(name)}`))));
    }
    if (this.manage) {
      for (const p of st.profiles) {
        if (this.form?.type === "label" && this.form.profile === p.name) { body.push(labelForm(this, t)); continue; }
        const isActive = p.name === st.active;
        body.push(h_flex().id(`mp-${p.name}`).gap(8).items_center().text_size(12)
          .child(div().size(6).flex_none().rounded_full().bg(this.accountColor(p, t)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().child(`${p.label}${p.label !== p.name ? `  ·  ${p.name}` : ""}`))
            .child(div().truncate().text_size(11).text_color(t.dim).child(p.gateway ? `${host(p.gateway)} · key ${p.hasKey ? "set" : "missing"}` : "claude.ai login")))
          .child(this.link(`rn-${p.name}`, "Rename", cx => openLabelForm(this, p, cx), t))
          .when(Boolean(p.gateway), el => el.child(this.link(`key-${p.name}`, p.hasKey ? "Replace key" : "Add key", cx => this.openKey(p.name, cx), t, p.hasKey ? null : t.ansi1)))
          .when(!isActive, el => el.child(this.link(`rm-${p.name}`, this.removing === p.name ? "Click to confirm" : "Remove", cx => this.removeProfile(p, cx), t, t.ansi1))));
        if (this.keyEdit?.profile === p.name) {
          body.push(h_flex().gap(6).items_center()
            .child(Input.new(this.keyEdit.input).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12))
            .child(this.button("key-save", "Save", "primary", cx => this.saveKey(cx), t))
            .child(this.button("key-cancel", "Cancel", null, cx => { this.keyEdit = null; this.handle.focus(); cx.notify(); }, t)));
        }
        body.push(this.varRows(p, t));
        body.push(...this.errorOf(`rm-${p.name}`, t));
      }
    }
    if (this.form?.type === "profile") body.push(profileForm(this, t));
    else body.push(h_flex().gap(12)
      .child(this.link("add-profile", "+ Add profile", cx => openProfileForm(this, cx), t, t.accent))
      .child(this.link("manage-profiles", this.manage ? "Done" : "Manage profiles", cx => { this.manage = !this.manage; this.removing = null; cx.notify(); }, t)));
    return this.card(0, "Account", "New Claude sessions start on this account; running ones keep theirs.", t,
      [...body, ...this.errorOf("account", t), ...this.errorOf("key", t), ...this.errorOf("vars", t), ...this.errorOf("label", t)]);
  }

  usageCard(t) {
    const body = [];
    for (const p of this.st.profiles) {
      const color = this.accountColor(p, t);
      if (this.form?.type === "usage" && this.form.profile === p.name) {
        body.push(v_flex().gap(6).child(h_flex().gap(6).items_center().child(div().size(8).rounded_full().bg(color)).child(div().font_semibold().child(`Usage for ${p.label}`))).child(usageForm(this, t)));
        continue;
      }
      if (!p.usage) {
        body.push(h_flex().id(`usage-cta-${p.name}`).gap(8).items_center().p(10).rounded(8).border_1().border_color(t.border).bg(t.background)
          .child(div().size(8).flex_none().rounded_full().bg(color))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(p.label))
          .child(this.button(`usage-setup-${p.name}`, `Set up usage`, null, cx => openUsageForm(this, p, cx), t)));
        continue;
      }
      const u = this.usage[p.name], r = u?.result;
      const head = h_flex().gap(6).items_center()
        .child(div().size(8).flex_none().rounded_full().bg(color))
        .child(div().font_semibold().child(p.label))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
          .child(r?.kind === "plan" && r.subscription ? `${titled(r.subscription)} plan` : p.gateway ? host(p.gateway) : ""))
        .when(Boolean(u), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(Date.now() - u.at))));
      const block = [head];
      if (!u) block.push(this.note("Loading…", t));
      else if (!r.ok) block.push(...this.usageError(p, r, t));
      else if (r.kind === "gateway" && !r.signedIn) block.push(...this.signinBlock(p, r, t));
      else if (r.kind === "gateway") block.push(...this.gatewayUsage(p, r, t, color));
      else if (r.kind === "plan") {
        for (const [g, title] of [["session", "Plan usage limits"], ["weekly", "Weekly limits"]]) {
          const rows = r.limits.filter(l => l.group === g);
          if (!rows.length) continue;
          block.push(div().pt(2).text_size(11).text_color(t.dim).child(title));
          rows.forEach((l, i) => block.push(this.limitRow(`plan-${p.name}-${g}-${i}`, l.label, resets(l.resetsAt), l.percent, t, color, l.severity)));
        }
        if (r.extra?.enabled) block.push(this.note(`Extra usage: ${r.extra.used ?? 0}${r.extra.limit ? ` / ${r.extra.limit}` : ""} ${r.extra.currency ?? ""}`, t));
      }
      block.push(h_flex().gap(12).justify_end()
        .child(this.link(`usage-edit-${p.name}`, "Change", cx => openUsageForm(this, p, cx), t))
        .child(this.link(`usage-off-${p.name}`, "Stop showing", cx => this.act(`usage-off-${p.name}`, "…", ["usage-remove", p.name], cx, { then: () => { delete this.usage[p.name]; } }), t)));
      body.push(v_flex().gap(7).p(10).rounded(8).border_1().border_color(p.name === this.st.active ? color : t.border).bg(t.background).children(block));
    }
    return this.card(1, "Usage", "Each account's limits, for the accounts you set it up for.", t, body);
  }

  // A failed usage read: say what happened and offer the way out (retry, sign in again, /login).
  usageError(p, r, t) {
    const s = this.signin?.profile === p.name ? this.signin : null;
    if (r.auth === "device" && s) return this.signinBlock(p, { auth: "device", expired: true }, t);
    const where = r.kind === "plan" ? "claude.ai" : p.gateway ? host(p.gateway) : p.label;
    const msg = r.timedOut ? `${where} didn't answer in time.` : r.error;
    const hint = r.kind === "plan" && !r.timedOut ? "If this keeps failing, run /login in a Claude session on this account." : null;
    return [
      this.note(msg, t, r.expired ? t.ansi3 : t.ansi1),
      ...(hint ? [this.note(hint, t)] : []),
      h_flex().gap(8)
        .child(this.button(`usage-retry-${p.name}`, "Retry", null, cx => this.loadUsageOne(p.name, cx), t))
        .when(r.auth === "device", el => el.child(this.button(`usage-signin-${p.name}`, "Sign in again", null, cx => this.startSignin(p.name, cx), t))),
    ];
  }

  signinBlock(p, r, t) {
    const s = this.signin?.profile === p.name ? this.signin : null;
    if (r.auth !== "device") return [this.note(`${p.label} has no key for the usage API: add one under Manage profiles.`, t, t.ansi3)];
    if (s?.status === "waiting") {
      return [v_flex().gap(6)
        .child(this.note("Approve this code in the browser page that just opened:", t, t.foreground))
        .child(h_flex().gap(10).items_center()
          .child(div().px(10).py(4).rounded(6).border_1().border_color(t.accent).font_family("JetBrains Mono").text_size(15).font_semibold().child(s.code))
          .child(svg(`${CHROME}/spinner.svg`).size(12).spin(900).text_color(t.dim))
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Waiting for approval…")))
        .child(h_flex().gap(8)
          .child(this.button("signin-open", "Open page again", null, () => exec("open", [s.url]), t))
          .child(this.button("signin-cancel", "Cancel", null, cx => { this.signin = null; cx.notify(); }, t)))];
    }
    return [
      this.note(r.expired ? `Your ${p.label} sign-in expired.` : `Sign in to ${p.label} to see its usage (approve a code in your browser).`, t, r.expired ? t.ansi3 : t.dim),
      ...(s?.status === "failed" ? [this.note(s.error, t, t.ansi1)] : []),
      h_flex().child(this.button(`signin-${p.name}`, r.expired ? "Sign in again" : `Sign in to ${p.label}`, "primary", cx => this.startSignin(p.name, cx), t, { busy: s?.status === "starting" ? "Starting…" : null })),
    ];
  }

  limitRow(id, label, sub, pct, t, color, severity = "normal", { extra, extraColor, tip } = {}) {
    const p = Math.max(0, Math.min(100, pct ?? 0));
    const bar = severity !== "normal" || p >= 90 ? t.ansi1 : p >= 75 ? t.ansi3 : color;
    return h_flex().id(id).gap(10).items_center().when(Boolean(tip), el => el.tooltip(tip))
      .child(v_flex().w(132).flex_none().min_w(0)
        .child(div().truncate().text_size(12.5).child(label))
        .child(div().truncate().text_size(11).text_color(t.dim).child(sub))
        .when(Boolean(extra), el => el.child(div().truncate().text_size(11).text_color(extraColor ?? t.dim).child(extra))))
      .child(div().flex_1().min_w(40).h(7).rounded_full().bg(t.border)
        .child(div().h_full().rounded_full().bg(bar).w(`${Math.max(p, 1.5)}%`)))
      .child(div().w(62).flex_none().text_right().text_size(11.5).text_color(p >= 75 ? t.foreground : t.muted).child(`${Math.round(p)}% used`));
  }

  // A gateway usage response in the daily-limits shape (providers with token/request limits,
  // a forecast and a timezone), with an optional budget. Anything else shows its plain numbers.
  gatewayUsage(p, r, t, color) {
    const u = r.usage ?? {}, rows = [];
    const providers = Object.entries(u.providers ?? {}).filter(([, v]) => v && (v.token_limit || v.request_limit));
    if (providers.length) {
      const tz = /JST|Tokyo/.test(u.timezone ?? "") ? 9 : null;
      if (u.usage_limits_enabled === false) rows.push(this.note("Daily limits are off right now.", t));
      else if (tz != null) {
        const local = new Date(Date.now() + tz * 3600e3);
        const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - tz * 3600e3;
        rows.push(div().pt(2).text_size(11).text_color(t.dim).child(`Daily limits · ${resets(new Date(midnight).toISOString()).toLowerCase()}`));
      } else rows.push(div().pt(2).text_size(11).text_color(t.dim).child(`Daily limits${u.day_key ? ` · ${u.day_key}` : ""}`));
      for (const [key, v] of providers) {
        const used = v.credit_adjusted_tokens ?? v.tokens_used ?? 0, reqs = v.credit_adjusted_requests ?? v.requests_used ?? 0;
        const tokPct = v.token_limit ? (100 * used) / v.token_limit : 0;
        const reqPct = v.request_limit ? (100 * reqs) / v.request_limit : 0;
        const pace = v.forecast?.tokens?.projected_pct_of_limit ?? null;
        const eta = v.forecast?.predicted_first_eta;
        const extra = eta ? `limit ~${resets(eta).replace(/^Resets (in )?/, "")}` : pace != null && used > 0 ? `on pace for ${Math.round(pace)}% today` : null;
        rows.push(this.limitRow(`gw-${p.name}-${key}`, key === "anthropic" ? "Claude" : titled(key), `${fmt(used)} / ${fmt(v.token_limit)} tokens`,
          Math.max(tokPct, reqPct), t, color, eta ? "warning" : "normal", {
            extra, extraColor: eta || pace >= 75 ? t.ansi3 : t.dim,
            tip: `${fmt(used)} of ${fmt(v.token_limit)} tokens, ${fmt(reqs)} of ${fmt(v.request_limit)} requests`,
          }));
      }
      const x = u.extra_usage;
      if (x?.available) rows.push(this.note(`Extra usage available: ${fmt(x.tokens)} tokens · ${fmt(x.requests)} requests`, t));
    } else {
      const scalars = Object.entries(u).filter(([, v]) => typeof v === "number" || typeof v === "string").slice(0, 6);
      rows.push(this.note("Connected. This usage format isn't one the panel draws yet; its fields:", t));
      for (const [k, v] of scalars) rows.push(h_flex().gap(8).text_size(11.5).child(div().w(140).text_color(t.dim).truncate().child(titled(k))).child(div().truncate().child(String(v))));
    }
    const b = r.budget;
    if (b && typeof b.current_spend_usd === "number") rows.push(b.budget_usd
      ? this.limitRow(`gw-${p.name}-budget`, "Budget", `$${b.current_spend_usd.toFixed(2)} / $${b.budget_usd.toFixed(2)}`, (100 * b.current_spend_usd) / b.budget_usd, t, color)
      : this.note(`Spend this period: $${b.current_spend_usd.toFixed(2)} · no budget cap`, t));
    if (r.auth === "device") rows.push(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(b?.username ? `Signed in as ${b.username}` : "Signed in"))
      .child(this.link(`signout-${p.name}`, "Sign out", cx => this.signOut(p.name, cx), t)));
    return rows;
  }

  folderCard(t) {
    const st = this.st, pin = st.local, vpin = st.claude.local;
    const body = [
      div().text_size(11.5).text_color(t.muted).truncate().child(tilde(st.root ?? st.where)),
      h_flex().gap(6).flex_wrap().items_center()
        .child(div().w(54).text_size(11.5).text_color(t.dim).child("Account"))
        .child(this.chip("pin-p-none", `Global (${this.label(st.active)})`, !pin, cx => this.pinProfile("-", cx), t))
        .children(st.profiles.map(p => this.chip(`pin-p-${p.name}`, p.label, pin?.value === p.name, cx => this.pinProfile(p.name, cx), t, this.accountColor(p, t)))),
      h_flex().gap(6).flex_wrap().items_center()
        .child(div().w(54).text_size(11.5).text_color(t.dim).child("Version"))
        .child(this.chip("pin-v-none", `Global (${st.claude.global ?? "none"})`, !vpin, cx => this.pinVersion("-", cx), t))
        .children(st.claude.installed.map(v => this.chip(`pin-v-${v}`, v, vpin?.value === v, cx => this.pinVersion(v, cx), t))),
    ];
    if (pin && pin.dir !== (st.root ?? st.where)) body.push(this.note(`Account pinned by ${tilde(pin.file)}`, t));
    if (vpin && vpin.dir !== (st.root ?? st.where)) body.push(this.note(`Version pinned by ${tilde(vpin.file)}`, t));
    if (st.localMissing) body.push(this.note(`Pinned to "${pin.value}", which isn't a profile: Claude starts here with no account settings. Pick one above.`, t, t.ansi1));
    if (st.pinIgnored) body.push(this.note("Ignored for now: ~/.claude/settings.json sets a gateway (from `cvm profile use` in a terminal), which wins over the pin. The panel clears it on its next refresh.", t, t.ansi3));
    if (vpin && !st.claude.installed.includes(vpin.value)) body.push(this.note(`${vpin.value} isn't installed: claude won't start here.`, t, t.ansi1));
    return this.card(2, "This folder", "Pins for the focused terminal's repo (.claude-profile, .claude-version).", t, [...body, ...this.errorOf("pinProfile", t), ...this.errorOf("pinVersion", t)]);
  }

  versionsCard(t) {
    const st = this.st, latest = this.remote?.latest?.claude, stable = this.remote?.latest?.claudeStable;
    const rows = st.claude.installed.map(v => {
      const isGlobal = v === st.claude.global, isLocal = v === st.claude.local?.value;
      const tags = [isGlobal && "global", isLocal && "this folder", v === latest && "latest", v === stable && "stable"].filter(Boolean);
      return h_flex().id(`ver-${v}`).h(30).gap(8).items_center()
        .child(div().size(7).flex_none().rounded_full().bg(isGlobal ? t.accent : t.border))
        .child(div().font_family("JetBrains Mono").text_size(12.5).child(v))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tags.join(" · ")))
        .when(!isGlobal, el => el.child(this.button(`use-${v}`, "Use", null, cx => this.act(`ver-${v}`, "Switching…", ["use-version", v], cx), t, { busy: this.busy[`ver-${v}`] }))
          .when(!isLocal, el => el.child(this.button(`rm-${v}`, "Remove", "danger", cx => this.act(`ver-${v}`, "Removing…", ["uninstall", v], cx), t, { busy: this.busy[`ver-${v}`] }))));
    });
    const body = [...rows];
    const missing = [latest, stable].filter((v, i, a) => v && a.indexOf(v) === i && !st.claude.installed.includes(v));
    if (missing.length) body.push(h_flex().gap(8).flex_wrap()
      .children(missing.map(v => this.button(`inst-${v}`, `Install ${v === latest ? "latest" : "stable"} ${v}`, v === latest ? "primary" : null,
        cx => this.act(`inst-${v}`, `Installing ${v}…`, ["install", v], cx, { toast: `Claude ${v} installed` }), t, { busy: this.busy[`inst-${v}`] }))));
    for (const v of missing) body.push(...this.errorOf(`inst-${v}`, t));
    for (const v of st.claude.installed) body.push(...this.errorOf(`ver-${v}`, t));
    body.push(this.note("A version change applies to new sessions.", t));
    return this.card(3, "Claude versions", `cvm ${st.cvm.version ?? ""}`, t, body);
  }

  updatesCard(t) {
    const rows = this.updates().map(u => h_flex().id(`up-${u.id}`).h(30).gap(8).items_center()
      .child(div().w(96).flex_none().truncate().child(u.label))
      .child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(11.5).text_color(u.available ? t.foreground : t.dim)
        .child(u.have ? (u.available ? `${u.have} → ${u.latest}` : `${u.have}${u.latest ? "" : " · ?"}`) : "not installed"))
      .when(u.available, el => el.child(this.button(`upd-${u.id}`, "Update", "primary", cx => this.update(u), t, { busy: this.busy[`up-${u.id}`] })))
      .when(!u.available && Boolean(u.have && u.latest), el => el.child(div().text_size(11).text_color(t.ansi2).child("up to date"))));
    const errs = this.updates().flatMap(u => this.errorOf(`up-${u.id}`, t));
    const remoteErrs = Object.keys(this.remote?.errors ?? {});
    return this.card(4, "Updates", "Plugin updates apply to new Claude sessions (or /reload-plugins).", t, [
      ...rows, ...errs, ...this.errorOf("updates", t),
      ...(remoteErrs.length ? [this.note(`Couldn't check: ${remoteErrs.join(", ")}`, t, t.ansi3)] : []),
      h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.remote?.at ? `Checked ${ago(Date.now() - this.remote.at)}` : "Not checked yet"))
        .child(this.button("check", "Check now", null, cx => this.checkUpdates(cx), t, { busy: this.busy.check })),
    ]);
  }

  routerCard(t) {
    const st = this.st;
    if (!st.plugins["agent-router"]?.version) {
      return this.card(5, "Agent router (optional)", "Per-role models for subagents through a gateway, and a prompt-cache bar (keepalive).", t, [
        h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Not installed. Needs Node 22+ and git."))
          .child(this.button("router-install", "Install", "primary", cx => this.act("setup-router", "Installing…", ["setup", "router"], cx,
            { toast: "Agent router installed", then: (_r, cx) => this.loadRouter(cx) }), t, { busy: this.busy["setup-router"] })),
        ...this.errorOf("setup-router", t),
      ]);
    }
    const ar = this.router?.agent_router, ka = this.router?.keepalive;
    const active = st.profiles.find(p => p.name === st.active);
    const status = !st.plugins["agent-router"].enabled ? ["Agent Router is disabled.", t.ansi3]
      : active?.gateway ? [`Routing on through ${active.label}.`, t.ansi2]
      : [`Idle on ${this.label(st.active)}: routing needs a gateway account.`, t.dim];
    const body = [this.note(status[0], t, status[1])];
    if (!this.router) body.push(this.note("Loading options…", t));
    else if (this.router.ok === false) body.push(this.note(this.router.error, t, t.ansi1));
    if (ar?.values) {
      for (const [role, label, hint] of ROLES) {
        const model = ar.values[`${role}_model`], effort = ar.values[`${role}_effort`] ?? "default";
        const efforts = ar.schema?.[`${role}_effort`]?.options ?? ["default"];
        body.push(h_flex().id(`role-${role}`).gap(8).items_center()
          .child(v_flex().w(84).flex_none().child(div().text_size(12.5).child(label)).child(div().text_size(10.5).text_color(t.dim).truncate().child(hint)))
          .child(h_flex().id(`model-${role}`).flex_1().min_w(0).h(26).px(8).gap(4).items_center().rounded(6).border_1()
            .border_color(this.picking === role ? t.accent : t.border).bg(t.background).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((e, cx) => { cx.stop_propagation(); this.pickModel(role, cx); })
            .child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(11.5).text_color(model ? t.foreground : t.dim).child(model || (role === "teammate" ? "each role's model" : "not set")))
            .child(svg(`${CHROME}/chevron-down.svg`).size(12).flex_none().text_color(t.dim)))
          .child(h_flex().id(`effort-${role}`).w(78).h(26).px(8).gap(4).flex_none().items_center().rounded(6).border_1()
            .border_color(this.picking === `effort:${role}` ? t.accent : t.border).bg(t.background).cursor_pointer().hover(s => s.bg(t.hover))
            .tooltip("Effort")
            .on_click((e, cx) => { cx.stop_propagation(); this.picking = this.picking === `effort:${role}` ? null : `effort:${role}`; cx.notify(); })
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(effort === "default" ? t.dim : t.foreground)
              .child(this.busy[`opt-${role}_effort`] ? "…" : effort === "default" ? "effort" : effort))
            .child(svg(`${CHROME}/chevron-down.svg`).size(12).flex_none().text_color(t.dim))));
        if (this.picking === role) body.push(this.modelList(role, model, t));
        if (this.picking === `effort:${role}`) body.push(this.effortList(role, effort, efforts, t));
      }
      body.push(this.note("New sessions use saved models; /agent-models-apply applies them to a running one.", t));
    }
    if (ka?.values) {
      const row = (key, label) => {
        const opts = ka.schema?.[key]?.options ?? [], v = ka.values[key] ?? ka.schema?.[key]?.default;
        return h_flex().gap(6).flex_wrap().items_center()
          .child(div().w(84).flex_none().text_size(12).child(label))
          .children(opts.map(o => this.chip(`ka-${key}-${o}`, o, o === v, cx => this.setOption("keepalive", key, o, cx), t)));
      };
      body.push(div().h(1).bg(t.border));
      body.push(div().text_size(12.5).font_semibold().child("Keepalive"));
      body.push(row("cache_upkeep", "Upkeep"));
      body.push(row("cache_ttl", "Cache TTL"));
    }
    body.push(...Object.keys(this.errors).filter(k => k.startsWith("opt-")).flatMap(k => this.errorOf(k, t)));
    return this.card(5, "Agent router", "Model and effort per subagent role, from the gateway's catalog.", t, body);
  }

  effortList(role, current, efforts, t) {
    return h_flex().id(`efforts-${role}`).w_full().justify_end().child(v_flex().w(78).flex_none().p(3).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .children(efforts.map(o => h_flex().id(`e-${role}-${o}`).h(24).px(5).flex_none().items_center().rounded(5).cursor_pointer()
        .bg(o === current ? t.selected : t.popover).hover(s => s.bg(t.hover))
        .on_click((e, cx) => { cx.stop_propagation(); this.setOption("agent-router", `${role}_effort`, o, cx); })
        .child(div().text_size(12).text_color(o === "default" ? t.dim : t.foreground).child(o)))));
  }

  modelList(role, current, t) {
    const gw = this.gatewayProfile();
    if (!gw) return this.note("No gateway account with a key: models come from the gateway.", t, t.ansi3);
    if (!this.models) return this.note(`Loading ${gw.label} models…`, t);
    if (this.models.error) return this.note(this.models.error, t, t.ansi1);
    const items = role === "teammate" ? [{ id: "", name: "Each role's own model" }, ...this.models] : this.models;
    return v_flex().id(`models-${role}`).ml(92).max_h(220).overflow_y_scrollbar().p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .children(items.map(m => h_flex().id(`m-${role}-${m.id || "none"}`).h(26).px(8).gap(8).flex_none().items_center().rounded(5).cursor_pointer()
        .bg(m.id === (current ?? "") ? t.selected : t.popover).hover(s => s.bg(t.hover))
        .on_click((e, cx) => { cx.stop_propagation(); this.setOption("agent-router", `${role}_model`, m.id, cx); })
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.name))
        .child(div().flex_none().font_family("JetBrains Mono").text_size(10.5).text_color(t.dim).child(m.id))));
  }

  render(cx) {
    const t = theme();
    this.hadKeys = this.handle.is_focused();
    if (this.st && location() !== this.st.where) this.refresh(cx);
    const st = this.st;
    const typing = Boolean(this.keyEdit || this.form || this.varEdit);
    const headerNote = !st ? "" : this.setupShown ? "Setup" : st.localMissing ? `${st.local.value}? (missing profile)` : this.label(st.effective);
    const iconButton = (id, icon, tip, action) => div().id(id).size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((e, cx) => { cx.stop_propagation(); action(cx); }).child(svg(icon).size(14));
    return v_flex().id("claude").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1()
      .border_color(this.hadKeys ? t.accent : t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => { if (!typing) this.handle.focus(); })
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(h_flex().h(42).flex_none().px(14).gap(4).items_center().border_b(1).border_color(t.border)
        .child(svg(`${ME}/claude.svg`).size(15).text_color(t.accent))
        .child(div().pl(4).font_semibold().child("Claude"))
        .child(div().pl(4).flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(headerNote))
        .when(Boolean(st) && !this.setupShown, el => el.child(iconButton("setup-open", `${CHROME}/settings.svg`, "Setup", cx => this.openSetup(cx))))
        .child(iconButton("refresh", "mods/servers/restart.svg", "Refresh (r)", cx => {
          this.refresh(cx);
          if (this.setupShown) loadDoctor(this, cx); else { this.loadRouter(cx); this.loadUsage(cx); }
        }))
        .when(this.setupShown && Boolean(st?.setup?.basics), el => el.child(iconButton("setup-close", `${CHROME}/x.svg`, "Back to the panel", cx => this.closeSetup(cx)))))
      .child(v_flex().id("claude-body").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(8).gap(8)
        .when(!st, el => el.child(div().p(16).text_size(12.5).text_color(this.err ? t.ansi1 : t.dim).child(this.err ?? "Loading…")))
        .when(Boolean(st) && this.setupShown, el => el.child(setupView(this, t)))
        .when(Boolean(st) && !this.setupShown, el => el.children([this.accountCard(t), this.usageCard(t), this.folderCard(t), this.versionsCard(t), this.updatesCard(t), this.routerCard(t)])))
      .child(keybar(t, { id: "claude", chips: typing ? KEYS.input : KEYS.panel, width: this.size?.width, onKeys: cx => { this.keysOpen = true; this.handle.focus(); cx.notify(); } }))
      .when(Boolean(this.keysOpen), el => el.child(keysCard(t, { id: "claude", title: "Claude: all keys", onClose: cx => { this.keysOpen = false; cx.notify(); },
        groups: [{ title: "Panel", chips: KEYS.panel }, { title: "Moving", chips: [{ caps: ["g", "G"], label: "first / last section" }, { caps: ["escape"], label: "back to the terminal" }] }, { title: "Typing", chips: KEYS.input }] })));
  }
}
