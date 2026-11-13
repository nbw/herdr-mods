// A lazygit-style git panel: numbered sections, vim-ish keys, writes run in core
// terminals whose output stays in a copyable log, and conflicts/failures hand off to an agent.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { keybar, keysCard } from "./keybar.js";
import { spaces, panes, focused, agents, knownAgents, exec, hc, run, theme, settings, props, appHome, watchFolder, nextCommand, readTextFile, writeTextFile, setShared, shared } from "herdr";
import * as G from "./git.js";
import { graphCell } from "./graph.js";
import { SelfUpdate } from "./update.js";
import { closePanel, hidePanel, revealPanel } from "./panel.js";
import { findRepoConfig } from "./repos.js";

const commitDraft = root => (shared("git.commitDrafts") ?? {})[root] ?? "";
function setCommitDraft(root, msg) {
  const all = { ...(shared("git.commitDrafts") ?? {}) };
  if (msg) all[root] = msg; else delete all[root];
  setShared("git.commitDrafts", all);
}

const ROW = 22, LINE = 18;
const CHROME = "mods/workspace-chrome";
const SECTIONS = [
  { id: "branches", key: "3", title: "Branches", cap: 5, tabs: ["PRs", "Local", "Remote"] },
  { id: "files", key: "6", title: "Files", cap: 6 },
  { id: "commits", key: "4", title: "Commits", cap: 6, tabs: ["Branch", "All"] },
];
const LISTS = ["branches0", "branches1", "branches2", "files", "commits0", "commits1", "stash"];
const PR_COLOR = { OPEN: "ansi2", MERGED: "ansi5", CLOSED: "ansi1" };
const { q } = G;

// `fixed`: the repo an expanded Git tab was opened on (its props, read once in init).
// `keep`: the last place; a mod pane in focus (the conflicts pane, a diff) has no folder, so it stays.
function location(fixed, keep) {
  if (fixed) return fixed;
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(x => x.pane === f.pane) : null;
  if (keep && pane && !pane.terminal && keep.space === space?.id) return keep;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id ?? null };
}

// lazygit spells keys "<c-p>", "<a-x>", "<space>"; keys here are "ctrl-p", "alt-x", "space".
const lazyKey = k => k.replace(/^<c-(.+)>$/, "ctrl-$1").replace(/^<a-(.+)>$/, "alt-$1").replace(/^<(.+)>$/, "$1");
const CONTEXTS = { global: () => true, localBranches: v => v.sec === "branches" && v.tab.branches === 1,
  remoteBranches: v => v.sec === "branches" && v.tab.branches === 2, commits: v => v.sec === "commits", stash: v => v.sec === "stash" };

function keyOf(e) {
  const m = e.modifiers ?? {};
  if (m.control || m.platform || m.alt) return e.keystroke;
  if (["enter", "escape", "tab", "space", "up", "down", "left", "right", "backspace", "pageup", "pagedown", "home", "end"].includes(e.key))
    return m.shift && ["tab", "up", "down"].includes(e.key) ? `shift-${e.key}` : e.key;
  return e.key_char ?? (m.shift ? e.key.toUpperCase() : e.key);
}

function lineKind(text, style) {
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(text)) return { kind: "file", text };
  if (text.startsWith("@@")) return { kind: "hunk", text };
  if (text.startsWith("+")) return { kind: "add", text };
  if (text.startsWith("-")) return { kind: "del", text };
  if (/^(commit |Author:|AuthorDate:|Commit:|CommitDate:|Merge:|── )/.test(text)) return { kind: "meta", text };
  return { kind: "", text };
}

// A patch split into one card per file: a header row (path, +/-), its hunks and lines, a gap between cards.
function fileCards(lines) {
  const rows = [];
  let card = null, oldNo = 0, newNo = 0;
  const close = () => { if (card?.last) card.last.last = true; };
  for (const raw of lines) {
    const text = raw.replace(/\t/g, "    ");
    const m = text.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      close();
      if (rows.length) rows.push({ kind: "gap" });
      card = { kind: "card", path: m[2], from: m[1] !== m[2] ? m[1] : null, status: null, add: 0, del: 0, last: null };
      rows.push(card);
      continue;
    }
    if (!card) continue;
    if (/^new file/.test(text)) { card.status = "new"; continue; }
    if (/^deleted file/.test(text)) { card.status = "deleted"; continue; }
    if (/^(index |--- |\+\+\+ |similarity|rename |old mode|new mode|dissimilarity|copy )/.test(text)) continue;
    const row = text.startsWith("@@") ? { kind: "hunk", text } : text.startsWith("+") ? { kind: "add", text } : text.startsWith("-") ? { kind: "del", text } : { kind: "", text };
    const at = row.kind === "hunk" && text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (at) { oldNo = Number(at[1]); newNo = Number(at[2]); }
    else if (row.kind === "add") row.new = newNo++;
    else if (row.kind === "del") row.old = oldNo++;
    else if (row.kind === "" && !text.startsWith("\\")) { row.old = oldNo++; row.new = newNo++; }
    if (row.kind === "add") card.add++;
    if (row.kind === "del") card.del++;
    row.inCard = true; card.last = row;
    rows.push(row);
  }
  close();
  for (const r of rows) if (r.kind === "card" && !r.last) r.last = r;
  return rows;
}

function commitCards(log) {
  const rows = [];
  for (const c of log) {
    if (rows.length) rows.push({ kind: "gap" });
    const card = { kind: "card", path: `${c.short}  ${c.subject}`, add: 0, del: 0 };
    const meta = { kind: "meta", text: `${c.author} · ${c.date}`, inCard: true };
    const body = c.body ? [{ kind: "", text: "", inCard: true }, ...c.body.split("\n").map(l => ({ kind: "", text: l.replace(/\t/g, "    "), inCard: true }))] : [];
    rows.push(card, meta, ...body);
    card.last = rows.at(-1); card.last.last = true;
  }
  return rows;
}

export default class Git extends View {
  init(_props, cx) {
    this.selfUpdate = new SelfUpdate("git", "Git panel"); this.selfUpdate.start(cx);
    this.handle = cx.focus_handle();
    // Props read later can belong to another copy (gitview's recipe saw it), so read them once.
    const p = props();
    this.fixed = p?.cwd ? { cwd: p.cwd, on: p.on ?? null } : null;
    if (this.fixed) cx.timer.after(150, () => this.handle.focus());
    this.scrolls = Object.fromEntries([...LISTS, "main"].map(k => [k, VirtualListScrollHandle.new()]));
    this.sec = "branches"; this.tab = { branches: 0, commits: 0 };
    // Sizes dragged by hand (px): each section box's height, the sections column's width (wide), the main view's height (narrow).
    this.sizes = JSON.parse(localStorage.getItem("sizes") ?? "{}"); this.measured = {}; this.drag = null;
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.sel = {}; this.filter = {}; this.log = []; this.seq = 0; this.copied = [];
    this.mainTop = 0; this.mainToken = 0;
    this.seqEditor = `${appHome()}/mods/git/seq-edit.pl`;
    cx.spawn(async cx => {
      const r = await exec("sh", ["-c", 'printf %s "$SHELL"']).catch(() => null);
      this.shell = r?.stdout.trim() || "/bin/zsh";
      this.known = await knownAgents().catch(() => []);
      try { this.config = JSON.parse(await readTextFile(`${appHome()}/mods/git/config.json`) ?? "{}"); }
      catch (e) { this.config = {}; this.flash(`config.json: ${e}`, 8000); }
      cx.notify();
    });
    // "git.key:<k>" from keys.json (or herdr-app do) presses a panel key without focusing it.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") {
          // One retry in case the first focus didn't land; focus that landed and then moved
          // (leaving quickly, a click, the leader popup) is the person's choice, so no retry then.
          const token = this.focusToken = (this.focusToken ?? 0) + 1;
          this.handle.focus();
          cx.timer.after(40, () => { if (this.handle.is_focused()) this.focusToken++; });
          cx.timer.after(150, cx => { if (this.focusToken === token && !this.handle.is_focused()) { this.handle.focus(); cx.notify(); } });
        }
        else if (c === "expand" && !this.fixed) this.expand(cx);
        else if (c === "collapse" && this.fixed) this.collapse();
        else if (c.startsWith("go:")) this.go(c.slice(3));
        else if (c.startsWith("key:")) { const k = c.slice(4); this.menu ? this.menuKey(k, cx) : this.handleKey(k, cx); }
        cx.notify();
      }
    });
    cx.timer.every(800, cx => this.tick(cx));
    // GPUI has no blur event for a plain focus handle, so notice focus changes by polling (a redraw only on change).
    // Shared so the leader popup knows where its keys came from (it takes the keyboard when it opens).
    cx.timer.every(300, cx => {
      const k = this.keyboard();
      if (k !== this.sharedKeys) { this.sharedKeys = k; setShared(this.fixed ? "git.tabHasKeys" : "git.hasKeys", k); }
      if (k !== this.hadKeys) { this.hadKeys = k; cx.notify(); }
    });
    this.refresh(cx, true);
  }

  // ---- Data ------------------------------------------------------------------

  tick(cx) {
    if (this.flashMsg && Date.now() > this.flashMsg.until) { this.flashMsg = null; cx.notify(); }
    this.loadRepoConfig(cx);
    const k = JSON.stringify(this.where());
    if (k !== this.locKey) return this.refresh(cx, true);
    if (this.dirty || Date.now() - (this.lastHeavy ?? 0) > 30000) { const heavy = this.dirty !== "light"; this.dirty = null; this.refresh(cx, heavy); }
  }

  // `pick`: null follows the pane (but a pane in the config's own folder shows `default`),
  // "pane" always follows the pane, else a repo name from .herdr/git.toml.
  where() {
    if (this.fixed) return this.fixed;
    const auto = this.autoLoc = location(null, this.autoLoc), cfg = this.repoCfg;
    if (!cfg || this.pick === "pane") return auto;
    const repo = cfg.repos.find(r => r.name === this.pick)
      ?? (auto.cwd === cfg.base ? cfg.repos.find(r => r.name === cfg.default) ?? cfg.repos[0] : null);
    return repo ? { cwd: repo.cwd, on: auto.on, space: auto.space } : auto;
  }

  loadRepoConfig(cx) {
    if (this.fixed || this.repoCfgLoading) return;
    const auto = location(null, this.autoLoc);
    if (auto.cwd === this.repoCfgFor && Date.now() - (this.repoCfgAt ?? 0) < 10000) return;
    this.repoCfgLoading = true;
    cx.spawn(async cx => {
      try {
        const cfg = await findRepoConfig(auto.cwd, auto.on);
        if (cfg?.file !== this.repoCfg?.file) this.pick = null;
        this.repoCfg = cfg;
      } catch (e) { this.flash(`.herdr/git.toml: ${e.message ?? e}`, 8000); }
      finally {
        Object.assign(this, { repoCfgFor: auto.cwd, repoCfgAt: Date.now(), repoCfgLoading: false });
        cx.notify();
      }
    });
  }

  repoBar(t) {
    const repos = this.repoCfg?.repos ?? [], root = this.ctx?.root;
    const current = this.pick === "pane" ? null : repos.find(r => r.cwd === root);
    const palette = ["ansi4", "ansi2", "ansi5", "ansi6", "ansi3", "ansi1"];
    const chip = (id, label, color, on, pick) => h_flex().id(id).flex_1().min_w(0).h(24).px(6).items_center().justify_center().rounded(6)
      .bg(color).text_color(t.background).text_size(11.5).opacity(on ? 1 : 0.45).when(on, el => el.font_semibold())
      .cursor_pointer().hover(s => s.opacity(on ? 1 : 0.75))
      .on_click((_e, cx) => { this.pick = pick; this.refresh(cx, true); cx.notify(); }).child(div().truncate().child(label));
    return h_flex().flex_none().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(chip("git-repo-root", "root", t.muted, !current, "pane").flex_none().w(44))
      .children(repos.map((r, i) => chip(`git-repo-${i}`, r.name, t[r.color] ?? t[palette[i % palette.length]], r === current, r.name)))
      .child(h_flex().id("git-repo-add").flex_none().size(24).items_center().justify_center().rounded(6).border_1().border_color(t.border)
        .text_color(t.muted).text_size(14).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.addRepo(cx)).child("+"));
  }

  addRepo(cx) {
    const cfg = this.repoCfg;
    if (!cfg) return;
    this.ask("Add repo button", "", (input, cx) => {
      if (!input) return;
      const [path, name = path.replace(/\/+$/, "").split("/").pop()] = input.split(/\s+as\s+/);
      const cwd = path.startsWith("/") ? path : `${cfg.base}/${path.replace(/^\.\//, "")}`;
      cx.spawn(async cx => {
        try {
          if (!(await G.openRepo(cwd, this.loc?.on ?? null))) throw new Error(`not a git repo: ${cwd}`);
          if (cfg.repos.some(r => r.name === name)) throw new Error(`"${name}" is already a button`);
          const text = await readTextFile(cfg.file);
          await writeTextFile(cfg.file, `${text.replace(/\n*$/, "\n")}\n[[repo]]\nname = "${name}"\npath = "${path}"\n`, text);
          this.pick = name; this.repoCfgAt = 0; this.flash(`Added ${name}`);
        } catch (e) { this.flash(`Couldn't add: ${e.message ?? e}`, 6000); }
        cx.notify();
      });
    }, cx, { hint: `path from ${cfg.base.split("/").pop()}/, optionally "as <name>"` });
    cx.notify();
  }

  watch(ctx, cx) {
    const roots = [ctx.root, ...(ctx.gitDir.startsWith(ctx.root + "/") ? [] : [ctx.gitDir])];
    if (ctx.on) return;
    for (const dir of roots) cx.spawn(async () => {
      try {
        while (this.ctx === ctx) {
          const paths = await watchFolder(dir);
          if (this.ctx !== ctx) return;
          const heavy = paths.some(p => p === dir || p.startsWith(ctx.gitDir));
          this.dirty = heavy || this.dirty === true ? true : "light";
        }
      } catch {}
    });
  }

  refresh(cx, heavy) {
    if (this.refreshing) { this.again = this.again || (heavy ? "heavy" : "light"); return; }
    this.refreshing = true;
    const loc = this.loc = this.where(), k = JSON.stringify(loc);
    cx.spawn(async cx => {
      try {
        if (k !== this.locKey) {
          this.locKey = k;
          this.ctx = loc.cwd ? await G.openRepo(loc.cwd, loc.on) : null;
          this.cwd = loc.cwd;
          Object.assign(this, { status: null, op: null, branches: null, commits: null, stash: null, prs: null, prList: null, prsFailed: false, main: null, mainOverride: null, sel: {}, filter: {}, copied: [] });
          if (!this.ctx) return;
          this.base = await G.defaultRef(this.ctx);
          this.watch(this.ctx, cx);
          heavy = true; this.prsAt = 0;
        }
        const ctx = this.ctx;
        if (!ctx) return;
        const [status, op] = await Promise.all([G.loadStatus(ctx), G.loadOp(ctx)]);
        if (ctx !== this.ctx) return;
        this.status = status; this.op = op;
        if (heavy) {
          const [branches, commits, stash] = await Promise.all([G.loadBranches(ctx, this.base), G.loadCommits(ctx, this.tab.commits === 1 ? ["--all"] : ["HEAD"], this.base), G.loadStash(ctx)]);
          if (ctx !== this.ctx) return;
          Object.assign(this, { branches, commits, stash, lastHeavy: Date.now() });
        }
        if (!this.prsLoading && (Date.now() - (this.prsAt ?? 0) > 120000 || (!this.prList && !this.prsFailed))) {
          this.prsAt = Date.now(); this.prsLoading = true;
          cx.spawn(async cx => { const r = await G.loadPRs(ctx); this.prsLoading = false; if (ctx === this.ctx) { this.prsFailed = !r; cx.notify(); } if (r && ctx === this.ctx) { this.prs = r.byBranch; this.prList = r.list; if (this.sec === "branches" && this.tab.branches === 0) this.syncMain(cx); cx.notify(); } });
        }
        this.syncMain(cx, true);
      } catch (e) { this.flash(`Refresh failed: ${e}`); }
      finally {
        this.refreshing = false; cx.notify();
        if (this.again) { const h = this.again === "heavy"; this.again = null; this.refresh(cx, h); }
      }
    });
  }

  // ---- Lists & selection -----------------------------------------------------

  lk(sec = this.sec) { return sec === "branches" ? `branches${this.tab.branches}` : sec === "commits" ? `commits${this.tab.commits}` : sec; }

  rawItems(sec) {
    if (sec === "branches") return (this.tab.branches === 0 ? this.prList : this.tab.branches === 2 ? this.branches?.remote : this.branches?.local) ?? [];
    if (sec === "commits") return this.commits ?? [];
    if (sec === "files") return this.changedFiles();
    return this.stash ?? [];
  }

  // The files the main view's diff touches (its cards), each with where its card starts in the Code rows.
  changedFiles() {
    const rows = this.main?.codeRows;
    if (!rows) return [];
    if (this.filesOf !== rows) { this.filesOf = rows; this.files = rows.flatMap((r, i) => r.kind === "card" ? [{ ...r, at: i }] : []); }
    return this.files;
  }

  showFile(it, cx) {
    if (!this.main?.codeRows) return;
    if (this.mainTab !== "code") this.setMainTab("code", cx);
    // "top" brings an item to the nearest edge, so a file further down would land at the bottom:
    // jump past the end first, then come back up so its card lands at the top.
    this.mainTop = it.at;
    this.scrolls.main.scroll_to_item(this.main.codeRows.length - 1, "top");
    cx.notify();
    cx.timer.after(16, cx => { this.scrolls.main.scroll_to_item(it.at, "top"); cx.notify(); });
  }

  textOf(sec, it) {
    if (sec === "files") return `${it.path} ${it.from ?? ""}`;
    if (sec === "branches") return it.kind === "pr" ? `#${it.number} ${it.title} ${it.headRefName} ${it.author?.login ?? ""}` : `${it.name} ${it.subject}`;
    if (sec === "commits") return it.sha ? `${it.short} ${it.subject} ${it.author} ${it.refs.join(" ")}` : "";
    return it.message;
  }

  items(sec = this.sec) {
    const all = this.rawItems(sec), f = this.filter[this.lk(sec)]?.toLowerCase();
    return f ? all.filter(it => this.textOf(sec, it).toLowerCase().includes(f)) : all;
  }

  selIndex(sec = this.sec) {
    const items = this.items(sec);
    let i = Math.max(0, Math.min(this.sel[this.lk(sec)] ?? 0, items.length - 1));
    if (sec === "commits") { while (i < items.length - 1 && !items[i]?.sha) i++; }
    return i;
  }
  selected(sec = this.sec) { return this.items(sec)[this.selIndex(sec)] ?? null; }

  move(delta, cx, absolute) {
    const items = this.items();
    if (!items.length) return;
    let i = absolute != null ? absolute : this.selIndex() + delta;
    i = Math.max(0, Math.min(i, items.length - 1));
    if (this.sec === "commits") {
      const dir = (absolute != null ? (absolute === 0 ? 1 : -1) : Math.sign(delta)) || 1;
      let j = i;
      while (j >= 0 && j < items.length && !items[j].sha) j += dir;
      if (j < 0 || j >= items.length) { j = i; while (j >= 0 && j < items.length && !items[j].sha) j -= dir; }
      if (j >= 0 && j < items.length) i = j;
    }
    this.sel[this.lk()] = i;
    this.scrolls[this.lk()].scroll_to_item(i);
    this.mainOverride = null;
    this.syncMain(cx);
    if (this.sec === "files") this.showFile(items[i], cx);
    cx.notify();
  }

  toggleSection(id, cx) {
    this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id);
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
    cx.notify();
  }

  focusSection(id, cx) {
    if (this.collapsed.has(id)) this.toggleSection(id, cx);
    if (id !== "files") this.lastSec = id;
    if (this.sec !== id) { this.sec = id; this.mainOverride = null; this.mainFocus = false; this.syncMain(cx); }
    this.handle.focus();
    cx.notify();
  }

  switchTab(delta, cx) {
    const s = SECTIONS.find(x => x.id === this.sec);
    if (!s.tabs) return;
    this.tab[this.sec] = (this.tab[this.sec] + delta + s.tabs.length) % s.tabs.length;
    if (this.sec === "commits") this.refresh(cx, true);
    this.syncMain(cx); cx.notify();
  }

  // ---- Main view -------------------------------------------------------------

  // Files shows what another section picked, so the main view follows that section instead.
  mainSpec() {
    const sec = this.sec === "files" ? this.lastSec ?? "branches" : this.sec;
    const it = this.selected(sec), ctx = this.ctx;
    if (!it || !ctx) return null;
    switch (sec) {
      case "branches": {
        if (it.kind === "pr") return { key: `pr:${it.number}:${it.updatedAt}`, title: `#${it.number} · ${it.title}`, split: true, load: () => G.prShow(ctx, it.number) };
        const base = this.base, name = it.name;
        return { key: `b:${name}:${it.sha}:${base}`, title: base ? `${name} vs ${base}` : name, loadSplit: async () => {
          const [log, diff] = await Promise.all([G.branchLog(ctx, name, base), G.branchDiff(ctx, name, base)]);
          return { commitRows: commitCards(log), codeRows: fileCards(diff), commitLabel: `Commits · ${log.length}`,
            width: Math.min(30000, Math.max(300, ...diff.slice(0, 2000).map(l => l.length * 7.3 + 40))),
            emptyCommit: base ? `No commits on ${name} that aren't on ${base}` : "No base branch to compare with",
            emptyCode: base ? `No code changes between ${base} and ${name}` : "No base branch to compare with" };
        } };
      }
      case "commits": return it.sha ? { key: `c:${it.sha}`, title: `${it.short} · ${it.subject}`, split: true, load: () => G.commitShow(ctx, it.sha) } : null;
      case "stash": return { key: `s:${it.ref}:${it.message}`, title: `${it.ref} · ${it.message}`, split: true, load: () => G.stashShow(ctx, it.ref) };
    }
    return null;
  }

  syncMain(cx, force) {
    const spec = this.mainOverride ?? this.mainSpec();
    if (!spec) { this.main = null; return; }
    if (spec.log) { this.showLogEditor(spec.log); this.main = { key: spec.key, log: spec.log }; return; }
    if (spec.key === this.main?.key && !force) return;
    const same = spec.key === this.main?.key;
    this.main = { key: spec.key, title: spec.title, style: spec.style, rows: same ? this.main.rows : null, commits: same ? this.main.commits : null, width: same ? this.main.width : 0 };
    if (!same) this.mainTop = 0;
    const token = ++this.mainToken, main = this.main;
    if (spec.loadSplit) {
      cx.spawn(async cx => {
        const r = await spec.loadSplit().catch(e => ({ commitRows: [{ kind: "", text: String(e) }], codeRows: [] }));
        if (token !== this.mainToken) return;
        Object.assign(main, r);
        main.rows = this.mainTab === "commit" ? main.commitRows : main.codeRows;
        cx.notify();
      });
      return;
    }
    if (spec.commits) {
      cx.spawn(async cx => {
        const commits = await spec.commits().catch(() => []);
        if (token !== this.mainToken) return;
        main.commits = commits; main.rows = commits; main.width = 0;
        cx.notify();
      });
      return;
    }
    cx.spawn(async cx => {
      const lines = await spec.load().catch(e => [String(e)]);
      if (token !== this.mainToken) return;
      main.width = Math.min(30000, Math.max(300, ...lines.slice(0, 2000).map(l => l.length * 7.3 + 40)));
      if (spec.split) {
        const at = lines.findIndex(l => l.startsWith("diff --git"));
        main.commitRows = (at < 0 ? lines : lines.slice(0, at)).map(l => lineKind(l.replace(/\t/g, "    "), spec.style));
        main.codeRows = at < 0 ? [] : fileCards(lines.slice(at));
        main.rows = this.mainTab === "commit" ? main.commitRows : main.codeRows;
      } else main.rows = lines.map(l => lineKind(l.replace(/\t/g, "    "), spec.style));
      cx.notify();
    });
  }

  showLogEditor(entry) {
    const value = `$ ${entry.title}\n${entry.running ? "(running…)" : `(exit ${entry.code})`}\n\n${entry.output || (entry.running ? "" : "(no output)")}`;
    if (this.editorFor === entry.id && this.editorValue === value) return;
    this.editor?.release();
    this.editor = EditorState.new({ value, readonly: true, line_numbers: false, folding: false, soft_wrap: true, font_family: settings().font_family ?? "JetBrains Mono", font_size: 12 });
    this.editor.on("focus", (_e, cx) => { this.editorFocused = true; cx.notify(); });
    this.editor.on("blur", (_e, cx) => { this.editorFocused = false; cx.notify(); });
    this.editorFor = entry.id; this.editorValue = value;
  }

  showOutput(entry, cx) {
    this.mainOverride = { key: `log:${entry.id}:${entry.running}`, log: entry };
    this.syncMain(cx); cx.notify();
  }

  setMainTab(tab, cx) {
    this.mainTab = tab;
    const m = this.main;
    if (m?.codeRows) { m.rows = tab === "commit" ? m.commitRows : m.codeRows; this.mainTop = 0; this.scrolls.main.scroll_to_item(0, "top"); }
    cx.notify();
  }

  scrollMain(delta, cx) {
    const n = this.main?.rows?.length ?? 0;
    this.mainTop = Math.max(0, Math.min(n - 1, this.mainTop + delta));
    this.scrolls.main.scroll_to_item(this.mainTop, "top");
    cx.notify();
  }

  // ---- Running commands ------------------------------------------------------

  flash(text, ms = 3500) { this.flashMsg = { text, until: Date.now() + ms }; }

  // term: a core terminal through the login shell (hooks, network, prompts); otherwise exec.
  cmd(title, script, cx, { term = true, after, onFail } = {}) {
    if (!this.ctx) return;
    if (this.running) { this.flash("Wait for the running git command to finish"); cx.notify(); return; }
    const ctx = this.ctx, entry = { id: ++this.seq, title, script, code: null, output: "", at: Date.now(), running: true };
    this.log.unshift(entry); this.running = entry; this.failure = null;
    cx.notify();
    cx.spawn(async cx => {
      let r;
      if (term) r = await G.runScript(ctx, script, this.shell ?? "/bin/zsh", addr => { entry.addr = addr; cx.notify(); });
      else {
        const e = await exec("sh", ["-c", script], { cwd: ctx.root, on: ctx.on }).catch(e => ({ code: -1, stdout: "", stderr: String(e) }));
        r = { code: e.code, output: [e.stdout, e.stderr].filter(Boolean).join("\n").trim() };
      }
      Object.assign(entry, { code: r.code, output: r.output, running: false, addr: null });
      this.running = null;
      const op = await G.loadOp(ctx).catch(() => null);
      if (r.code === 0) after?.(cx);
      else {
        onFail?.(cx);
        // A merge or rebase that stopped on conflicts shows in the banner, not as a failure.
        if (!op) { this.failure = entry; this.showOutput(entry, cx); }
      }
      if (this.mainOverride?.log === entry) this.syncMain(cx, true);
      this.refresh(cx, true);
      cx.notify();
    });
  }

  confirm(title, label, action, cx, lines) {
    this.openMenu(title, [{ key: "y", label, danger: true, run: action }, { key: "n", label: "Cancel", run: () => {} }], cx, lines);
  }

  openMenu(title, items, cx, lines) {
    this.menu = { title, items: items.filter(Boolean), sel: 0, lines };
    cx.notify();
  }

  menuKey(k, cx) {
    const m = this.menu;
    if (k === "escape" || k === "q") { this.menu = null; }
    else if (k === "j" || k === "down") m.sel = Math.min(m.items.length - 1, m.sel + 1);
    else if (k === "k" || k === "up") m.sel = Math.max(0, m.sel - 1);
    else {
      const item = k === "enter" || k === "space" ? m.items[m.sel] : m.items.find(i => i.key === k);
      if (item && !item.disabled) { this.menu = null; item.run(cx); }
    }
    cx.notify();
  }

  // `onClose(text)`: esc closed it, with what was typed. `select: false` puts the cursor at the end.
  ask(title, value, onSubmit, cx, { hint, live, onClose, select = true } = {}) {
    const input = InputState.new({ value: value ?? "", placeholder: hint ?? "" });
    if (value) input.set_selected_range(select ? { start: 0, end: value.length } : { start: value.length, end: value.length });
    input.on("submit", (_e, cx) => { const v = input.value(); this.prompt = null; this.typing = false; this.handle.focus(); onSubmit(v.trim(), cx); cx.notify(); });
    input.on("change", (_e, cx) => { live?.(input.value(), cx); cx.notify(); });
    input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.prompt = { title, input, onCancel: cx => { live?.("", cx); onClose?.(input.value(), cx); } };
    this.typing = true;
    input.focus();
    cx.notify();
  }

  cancelPrompt(cx) {
    this.prompt?.onCancel?.(cx);
    this.prompt = null; this.typing = false; this.handle.focus(); cx.notify();
  }

  // ---- AI hand-off -----------------------------------------------------------

  conflicts() { return (this.status?.files ?? []).filter(f => f.conflict); }

  // The conflicts pane (mods/git-conflicts) beside the tab, on demand: v, or Resolve on the banner.
  openConflicts() {
    const tab = focused()?.tab, ctx = this.ctx;
    if (!tab || !ctx) return;
    const open = panes().find(p => p.tab === tab && p.mod === "git-conflicts");
    if (open) return run("pane.focus", { pane: open.pane });
    const p = { tab, root: ctx.root, gitDir: ctx.gitDir, on: ctx.on ?? null };
    (async () => {
      // Full height at the tab's right edge, as the Changes panel opens its diff (gitview's sidebar op).
      try {
        const cfg = JSON.parse(await readTextFile(`${appHome()}/mods/gitview/config.json`));
        const r = await exec("/usr/bin/env", ["GITVIEW_HOST=app", `HERDR_APP_HOME=${appHome()}`, ...(cfg.herdr_app ? [`GITVIEW_HERDR_APP=${cfg.herdr_app}`] : []), ...(cfg.hc ? [`GITVIEW_HC=${cfg.hc}`] : []),
          cfg.bin, "json", "sidebar", "--tab", tab, "--mod", "git-conflicts", "--props", JSON.stringify(p)]);
        const out = JSON.parse(r.stdout);
        if (r.code !== 0 || out.error) throw new Error(out.error);
        if (out.pane) run("pane.focus", { pane: out.pane });
      } catch {
        run("pane.split", { direction: "right", mod: "git-conflicts", props: p });
      }
    })();
  }

  conflictPrompt() {
    const op = this.op, root = this.ctx.root, files = this.conflicts().map(f => `- ${f.path}`);
    const what = op.kind === "rebase"
      ? `a rebase of \`${op.branch ?? "HEAD"}\` onto \`${op.other}\`${op.step ? ` (commit ${op.step} of ${op.total})` : ""}${op.current ? `, stopped while applying ${op.current}` : ""}`
      : op.kind === "merge" ? `a merge of \`${op.other}\` into \`${this.status?.info.head}\`${op.message ? ` (${op.message})` : ""}` : `a ${op.kind} of ${op.other}`;
    return [
      `I'm in the middle of ${what} in ${root}. These files have conflicts:`, ...files, "",
      ...(op.kind === "rebase" ? ["During a rebase, \"ours\"/HEAD is the upstream side and \"theirs\" is my commit being replayed.", ""] : []),
      "Please resolve them: check what each side changed and why (git log / git show on the commits involved), edit the files so both intents are kept, remove every conflict marker, run the relevant type-check/lint/tests for the touched files, then `git add` each resolved file.",
      `Don't run \`git ${op.kind} --continue\`, commit, or push: I'll review and continue myself. When you're done, summarize how you resolved each file.`,
    ].join("\n");
  }

  failurePrompt(entry) {
    const lines = entry.output.split("\n"), tail = lines.length > 300 ? ["… (earlier output trimmed)", ...lines.slice(-300)] : lines;
    const commit = /\bgit commit\b/.test(entry.title);
    return [
      `This git command failed in ${this.ctx.root} (exit ${entry.code}):`, "", `$ ${entry.title}`, "", "Output:", "```", ...tail, "```", "",
      commit ? "This is most likely the pre-commit hook. Please fix the reported problems and `git add` the fixes, but don't commit: I'll re-run the commit myself."
        : "Please find the cause and fix it. Don't re-run the git command yourself; tell me when it's safe to retry.",
    ].join("\n");
  }

  askAI(cx) {
    if (!this.ctx) return;
    let prompt, label;
    if (this.op && this.conflicts().length) { prompt = this.conflictPrompt(); label = "resolve conflicts"; }
    else if (this.mainOverride?.log && !this.mainOverride.log.running && this.mainOverride.log.code !== 0) { prompt = this.failurePrompt(this.mainOverride.log); label = "fix git failure"; }
    else if (this.failure) { prompt = this.failurePrompt(this.failure); label = "fix git failure"; }
    if (!prompt) { this.flash("Nothing to hand off: no conflicts or failed command selected"); cx.notify(); return; }
    const space = spaces().find(s => s.active);
    const here = agents().filter(a => a.space === space?.id);
    const fresh = this.known?.find(k => k.installed);
    this.openMenu(`Ask AI to ${label}`, [
      ...here.slice(0, 8).map((a, i) => ({ key: String(i + 1), label: `Send to ${a.program?.name ?? a.app ?? "agent"} · ${a.tab_name === (a.program?.name ?? a.app) ? `tab ${a.tab_index}` : a.tab_name}`, hint: a.status, run: cx => this.sendToAgent(a, prompt, label, cx) })),
      fresh && { key: "n", label: `New ${fresh.name} tab`, run: () => { run("tab.new", { argv: fresh.run, task: prompt, folder: this.ctx.root, name: `AI · ${label}` }); this.ai = { label, address: null }; } },
      { key: "y", label: "Copy prompt", run: cx => { cx.write_to_clipboard(prompt); this.flash("Prompt copied"); } },
    ], cx);
  }

  sendToAgent(agent, prompt, label, cx) {
    cx.spawn(async cx => {
      const r = await hc(["send", agent.address, prompt]).catch(e => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) this.flash(`Couldn't send: ${(r.stderr || r.stdout).trim()}`, 6000);
      else this.ai = { label, address: agent.address };
      cx.notify();
    });
  }

  // ---- Actions -----------------------------------------------------------------

  async baseOf(sha, depth) {
    const r = await G.git(this.ctx, ["rev-parse", "-q", "--verify", `${sha}~${depth}`]).catch(() => null);
    return r?.code === 0 ? `${sha}~${depth}` : "--root";
  }

  rewrite(title, c, cx, build) { this.rewriteMany(title, [c], cx, build); }

  // A history rewrite touching `commits` (asks first when any is pushed). The
  // range ends with it unless `keepRange` (moving a block keeps it selected).
  rewriteMany(title, commits, cx, build, { keepRange = false, terminal = false } = {}) {
    if (this.tab.commits !== 0) { this.flash("Rewrite commits from the Branch tab (] to switch)"); cx.notify(); return; }
    if (commits.some(c => c.parents.length > 1)) { this.flash("Can't rewrite a merge commit here"); cx.notify(); return; }
    const go = cx => cx.spawn(async cx => {
      const script = await build();
      if (!keepRange) this.clearRange();
      if (terminal) run("terminal.open", { argv: [this.shell ?? "/bin/zsh", "-lic", script], folder: this.ctx.root, place: "tab", name: title });
      else this.cmd(title, script, cx);
      cx.notify();
    });
    const pushed = commits.filter(c => c.state !== "unpushed");
    if (pushed.length) this.confirm(`${pushed.length > 1 ? `${pushed.length} of these commits are` : `${pushed[0].short} is`} already pushed. Rewriting needs a force push.`, "Rewrite anyway", go, cx);
    else go(cx);
  }

  // `a`: a commit, or several comma separated (each cut to 7 characters).
  todo(mode, a, b, op, base) {
    const short = a.split(",").map(x => x.slice(0, 7)).join(",");
    return `HERDR_MODE=${mode} HERDR_A=${short} HERDR_B=${(b ?? "").slice(0, 7)} HERDR_OP=${op ?? ""} GIT_SEQUENCE_EDITOR=${q(`perl ${q(this.seqEditor)}`)} git rebase -i --autostash --rebase-merges ${base}`;
  }

  // ---- lazygit's range select on commits (v, shift-↑/↓) ---------------------

  // The commits from the anchor to the selected one, newest first (as listed).
  rangeRows() {
    if (this.sec !== "commits" || !this.rangeAnchor) return [];
    const rows = this.items(), a = rows.findIndex(r => r.sha === this.rangeAnchor), b = this.selIndex();
    if (a < 0) return [];
    return rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter(r => r.sha);
  }

  clearRange() { this.rangeAnchor = null; }

  rangeActions(range, add) {
    const n = range.length, oldest = range.at(-1), shas = range.map(r => r.sha), list = shas.join(",");
    const many = (title, op, depth) => cx => this.rewriteMany(`${title} ${n} commits`, range, cx, async () => this.todo("replace", list, null, op, await this.baseOf(oldest.sha, depth)));
    add("s", `Squash ${n} commits into the one below`, many("squash", "squash", 2), { chip: `squash ${n}` });
    add("f", `Fixup ${n} commits into the one below`, many("fixup", "fixup", 2), { chip: `fixup ${n}` });
    add("d", `Drop ${n} commits`, cx => this.confirm(`Drop ${n} commits?`, "Drop commits", many("drop", "drop", 1), cx), { chip: `drop ${n}` });
    const rows = this.items(), top = rows.indexOf(range[0]), bottom = rows.indexOf(oldest);
    const below = rows.slice(bottom + 1).find(r => r.sha), above = rows.slice(0, top).reverse().find(r => r.sha);
    const cursorBy = d => { this.sel[this.lk()] = this.selIndex() + d; };
    if (below) add("ctrl-j", `Move ${n} commits down`, cx => this.rewriteMany(`move ${n} commits down`, [...range, below], cx, async () => {
      cursorBy(rows.indexOf(below) - bottom);
      return this.todo("move", list, below.sha, null, await this.baseOf(below.sha, 1));
    }, { keepRange: true }));
    if (above) add("ctrl-k", `Move ${n} commits up`, cx => this.rewriteMany(`move ${n} commits up`, [...range, above], cx, async () => {
      cursorBy(rows.indexOf(above) - top);
      return this.todo("move", list, above.sha, null, await this.baseOf(oldest.sha, 1));
    }, { keepRange: true }));
    add("C", `Mark ${n} commits for cherry-pick`, cx => { this.copied = [...new Set([...this.copied, ...shas])]; this.clearRange(); cx.notify(); });
    add("y", `Copy ${n} commit hashes`, cx => { cx.write_to_clipboard(shas.join("\n")); this.flash(`Copied ${n} hashes`); cx.notify(); });
    add("v", "End the range", cx => { this.clearRange(); cx.notify(); });
  }

  // Amend a commit with `args`: right away on HEAD, else stop at it in a rebase,
  // amend, continue. `terminal`: in a new tab (your editor opens there).
  amendHere(c, args, cx, { title, terminal = false } = {}) {
    const isHead = c.refs.some(r => r.startsWith("HEAD"));
    this.rewriteMany(title, [c], cx, async () => isHead ? `git commit --amend --only ${args}`.trim()
      : `${this.todo("replace", c.sha, null, "edit", await this.baseOf(c.sha, 1))} && git commit --amend --only ${args} && git rebase --continue`, { terminal });
  }

  // The commit's page on the origin remote (GitHub, GitLab, Bitbucket), or null.
  async commitUrl(sha) {
    const r = await G.git(this.ctx, ["remote", "get-url", "origin"]).catch(() => null);
    const url = r?.code === 0 ? r.stdout.trim() : "";
    const m = url.match(/^(?:git@|ssh:\/\/git@|https?:\/\/)([^/:]+)[:/](.+?)(?:\.git)?$/);
    if (!m) return null;
    return `https://${m[1]}/${m[2]}/${m[1].includes("bitbucket") ? "commits" : "commit"}/${sha}`;
  }

  // y: lazygit's copy menu.
  copyMenu(c, cx) {
    const copy = (text, what) => cx => { cx.write_to_clipboard(text); this.flash(`Copied ${what}`); cx.notify(); };
    cx.spawn(async cx => {
      const message = (await G.git(this.ctx, ["log", "-1", "--format=%B", c.sha]).catch(() => null))?.stdout.trim() ?? c.subject;
      const url = await this.commitUrl(c.sha);
      this.openMenu(`Copy from ${c.short}`, [
        { key: "h", label: "Commit hash", hint: c.short, run: copy(c.sha, c.short) },
        { key: "s", label: "Subject", run: copy(c.subject, "subject") },
        { key: "m", label: "Message", run: copy(message, "message") },
        url && { key: "u", label: "URL", run: copy(url, "URL") },
        c.author && { key: "a", label: "Author", hint: c.author, run: copy(c.author, "author") },
      ].filter(Boolean), cx);
      cx.notify();
    });
  }

  push(cx, force) {
    const info = this.status?.info;
    if (!info?.head || info.head === "(detached)") { this.flash("Not on a branch"); cx.notify(); return; }
    if (force) return this.cmd("git push --force-with-lease", "git push --force-with-lease", cx);
    if (!info.upstream) return this.cmd("git push -u origin HEAD", "git push -u origin HEAD", cx);
    if (info.ahead > 0 && info.behind > 0) return this.confirm(`${info.head} has diverged from ${info.upstream} (↑${info.ahead} ↓${info.behind})`, "Force push (with lease)", cx => this.push(cx, true), cx);
    if (info.behind > 0 && !info.ahead) { this.flash("Behind upstream: pull first (p)"); cx.notify(); return; }
    this.cmd("git push", "git push", cx);
  }

  opMenu(cx) {
    const op = this.op;
    if (!op) return;
    const n = this.conflicts().length;
    this.openMenu(`${op.kind} in progress${n ? ` · ${n} conflict${n > 1 ? "s" : ""}` : ""}`, [
      { key: "c", label: `Continue ${op.kind}`, disabled: n > 0, hint: n ? "resolve conflicts first" : null, run: cx => this.cmd(`git ${op.kind} --continue`, `git ${op.kind} --continue`, cx) },
      op.kind !== "merge" && { key: "s", label: `Skip this commit`, run: cx => this.cmd(`git ${op.kind} --skip`, `git ${op.kind} --skip`, cx) },
      { key: "a", label: `Abort ${op.kind}`, danger: true, run: cx => this.confirm(`Abort the ${op.kind}?`, `Abort ${op.kind}`, cx => this.cmd(`git ${op.kind} --abort`, `git ${op.kind} --abort`, cx), cx) },
      n > 0 && { key: "v", label: "Resolve conflicts (chunk picker)", run: () => this.openConflicts() },
      n > 0 && { key: "i", label: "Ask AI to resolve conflicts", run: cx => this.askAI(cx) },
      n > 0 && { key: "e", label: `Open conflicted file${n > 1 ? "s" : ""} in ${this.config?.editor ?? "editor"}`, run: () => cx_open(this, this.conflicts().map(f => f.path)) },
      n > 0 && { key: "r", label: `Mark conflicted file${n > 1 ? "s" : ""} resolved`, hint: "git add", run: cx => this.cmd("git add (resolved)", `git add -- ${this.conflicts().map(f => q(f.path)).join(" ")}`, cx, { term: false }) },
    ], cx, this.conflicts().slice(0, 10).map(f => f.path));
  }

  // Lazygit's "ours"/"theirs" confusion: during a rebase, ours is the upstream.
  sideLabels() {
    return this.op?.kind === "rebase" ? { ours: `upstream (${this.op.other ?? "onto"})`, theirs: "your commit" } : { ours: `current (${this.status?.info.head ?? "HEAD"})`, theirs: `incoming (${this.op?.other ?? "theirs"})` };
  }

  // lazygit's template fields for the selection, for custom commands.
  fill(command) {
    const it = this.selected(), sec = this.sec, info = this.status?.info;
    const fields = {
      "CheckedOutBranch.Name": info?.head,
      "SelectedLocalBranch.Name": sec === "branches" && it?.kind === "local" ? it.name : null,
      "SelectedRemoteBranch.Name": sec === "branches" && it?.kind === "remote" ? it.short : null,
      "SelectedRemoteBranch.RemoteName": sec === "branches" && it?.kind === "remote" ? it.remote : null,
      "SelectedLocalCommit.Hash": sec === "commits" ? it?.sha : null, "SelectedLocalCommit.Sha": sec === "commits" ? it?.sha : null,
      "SelectedLocalCommit.Name": sec === "commits" ? it?.subject : null,
      "SelectedStashEntry.Name": sec === "stash" ? it?.ref : null,
    };
    let missing = null;
    const text = command.replace(/\{\{\s*\.([\w.]+)\s*\}\}/g, (m, name) => { const v = fields[name]; if (v == null) missing = name; return v ?? ""; });
    return { text, missing };
  }

  customActions() {
    return (this.config?.customCommands ?? []).filter(c => c.key && c.command && (CONTEXTS[c.context ?? "global"] ?? (() => false))(this)).map(c => ({
      key: lazyKey(c.key), label: c.description ?? c.command, custom: true,
      run: cx => {
        const { text, missing } = this.fill(c.command);
        if (missing) { this.flash(`Custom command needs {{.${missing}}}: select one first`); cx.notify(); return; }
        if (c.output === "terminal") run("terminal.open", { argv: [this.shell ?? "/bin/zsh", "-lic", text], folder: this.ctx.root, place: "tab" });
        else this.cmd(c.description ?? text, text, cx, { after: () => { this.prsAt = 0; } });
      },
    }));
  }

  openWorktree(path) {
    const on = this.ctx?.on ?? null;
    const inside = cwd => cwd === path || cwd?.startsWith(`${path}/`);
    const all = panes();
    const s = spaces().find(s => (s.machine ?? null) === on && all.some(p => inside(p.cwd) && (s.tabs ?? []).some(t => t.id === p.tab)));
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: path, machine: on ?? "" });
  }

  actions() {
    const sec = this.sec, it = this.selected(), A = this.customActions();
    const add = (key, label, run, extra) => A.push({ key, label, run, ...extra });
    const info = this.status?.info, head = info?.head;
    if (sec === "files" && it) {
      add("space", "Show in Code", cx => this.showFile(it, cx));
      add("y", "Copy path", cx => { cx.write_to_clipboard(it.path); this.flash("Path copied"); });
    }
    if (sec === "branches" && it?.kind === "pr") {
      add("space", `Check out #${it.number} (${it.headRefName})`, cx => this.cmd(`gh pr checkout ${it.number}`, `gh pr checkout ${it.number}`, cx));
      add("o", "Open in browser", () => exec("open", [it.url]));
      add("y", "Copy PR link", cx => { cx.write_to_clipboard(it.url); this.flash("PR link copied"); });
      add("b", "Copy branch name", cx => { cx.write_to_clipboard(it.headRefName); this.flash("Branch name copied"); });
    } else if (sec === "branches" && it) {
      const remote = it.kind === "remote", ref = it.name;
      if (remote) add("space", it.local ? `Check out ${it.local}` : `Check out as local ${it.short}`, cx => it.local
        ? this.cmd(`git switch ${it.local}`, `git switch ${q(it.local)}`, cx)
        : this.cmd(`git switch -c ${it.short} --track ${ref}`, `git switch -c ${q(it.short)} --track ${q(ref)}`, cx));
      else add("space", it.worktree ? "Go to its worktree" : "Check out", cx => {
        if (it.head) return;
        // Git won't check a branch out twice: go to its worktree's space instead (opening one if none).
        if (it.worktree) return this.openWorktree(it.worktree);
        this.cmd(`git switch ${ref}`, `git switch ${q(ref)}`, cx);
      });
      add("n", "New branch from here", cx => this.ask(`New branch from ${ref}`, "", (name, cx) => name && this.cmd(`git switch -c ${name} ${ref}`, `git switch -c ${q(name)} ${q(ref)}`, cx), cx));
      if (!it.head) {
        add("M", `Merge into ${head}…`, cx => this.openMenu(`Merge ${ref} into ${head}`, [
          { key: "m", label: "Merge", hint: "fast-forward if possible", run: cx => this.cmd(`git merge ${ref}`, `git merge --no-edit ${q(ref)}`, cx) },
          { key: "n", label: "Merge commit (--no-ff)", run: cx => this.cmd(`git merge --no-ff ${ref}`, `git merge --no-ff --no-edit ${q(ref)}`, cx) },
          { key: "f", label: "Fast-forward only", run: cx => this.cmd(`git merge --ff-only ${ref}`, `git merge --ff-only ${q(ref)}`, cx) },
          { key: "s", label: "Squash (stage only, then commit)", run: cx => this.cmd(`git merge --squash ${ref}`, `git merge --squash ${q(ref)}`, cx) },
        ], cx));
        add("r", `Rebase ${head} onto this…`, cx => this.openMenu(`Rebase ${head} onto ${ref}`, [
          { key: "r", label: "Rebase", hint: "--autostash", run: cx => this.cmd(`git rebase ${ref}`, `git rebase --autostash ${q(ref)}`, cx) },
          { key: "u", label: "Rebase, updating stacked branches", hint: "--update-refs", run: cx => this.cmd(`git rebase --update-refs ${ref}`, `git rebase --autostash --update-refs ${q(ref)}`, cx) },
          { key: "m", label: "Rebase, keeping merge commits", hint: "--rebase-merges", run: cx => this.cmd(`git rebase --rebase-merges ${ref}`, `git rebase --autostash --rebase-merges ${q(ref)}`, cx) },
          { key: "a", label: "Rebase and apply fixup!/squash! commits", hint: "--autosquash", run: cx => this.cmd(`git rebase -i --autosquash ${ref}`, `GIT_SEQUENCE_EDITOR=: git rebase -i --autostash --autosquash ${q(ref)}`, cx) },
          { key: "i", label: "Interactive rebase in editor (new tab)", run: () => run("terminal.open", { argv: [this.shell ?? "/bin/zsh", "-lic", `git rebase -i --autostash ${q(ref)}`], folder: this.ctx.root, place: "tab" }) },
        ], cx));
      }
      if (!remote) {
        if (it.upstream && !it.gone) add("f", "Fast-forward from upstream", cx => it.head
          ? this.cmd("git merge --ff-only @{u}", "git fetch && git merge --ff-only @{u}", cx)
          : this.cmd(`git fetch ${it.upstream.replace("/", " ")}:${ref}`, `git fetch ${q(it.upstream.split("/")[0])} ${q(`${it.upstream.split("/").slice(1).join("/")}:${ref}`)}`, cx));
        add("R", "Rename", cx => this.ask(`Rename ${ref}`, ref, (name, cx) => name && name !== ref && this.cmd(`git branch -m ${ref} ${name}`, `git branch -m ${q(ref)} ${q(name)}`, cx, { term: false }), cx));
        if (!it.head) add("d", "Delete…", cx => this.openMenu(`Delete ${ref}`, [
          { key: "d", label: "Delete local branch", run: cx => this.deleteLocal(it, cx) },
          it.upstream && !it.gone && { key: "r", label: `Delete local and ${it.upstream}`, danger: true, run: cx => this.confirm(`Delete ${it.upstream} on the remote too?`, "Delete both", cx => this.cmd(`git branch -D ${ref} && git push ${it.upstream.split("/")[0]} --delete ${it.upstream.split("/").slice(1).join("/")}`, `git branch -D ${q(ref)} && git push ${q(it.upstream.split("/")[0])} --delete ${q(it.upstream.split("/").slice(1).join("/"))}`, cx), cx) },
        ], cx));
        add("D", "Clean up merged / closed / gone branches", cx => this.cleanup(cx));
      } else add("d", "Delete remote branch", cx => this.confirm(`Delete ${ref} on ${it.remote}?`, "Delete remote branch", cx => this.cmd(`git push ${it.remote} --delete ${it.short}`, `git push ${q(it.remote)} --delete ${q(it.short)}`, cx), cx));
      const pr = this.prs?.[remote ? it.short : ref];
      if (pr) add("o", `Open PR #${pr.number}`, () => exec("open", [pr.url]));
      add("y", "Copy branch name", cx => { cx.write_to_clipboard(remote ? it.short : ref); this.flash("Branch name copied"); });
    }
    if (sec === "commits" && it?.sha) {
      const c = it, range = this.rangeRows();
      if (range.length > 1) this.rangeActions(range, add);
      else {
        // lazygit's commit keys, in its order of usefulness (the footer shows the first).
        add("s", "Squash into the commit below", cx => this.rewrite(`squash ${c.short}`, c, cx, async () => this.todo("replace", c.sha, null, "squash", await this.baseOf(c.sha, 2))), { chip: "squash" });
        add("f", "Fixup into the commit below (drop message)", cx => this.rewrite(`fixup ${c.short}`, c, cx, async () => this.todo("replace", c.sha, null, "fixup", await this.baseOf(c.sha, 2))), { chip: "fixup" });
        add("r", "Reword", cx => this.reword(c, cx), { chip: "reword" });
        add("d", "Drop this commit", cx => this.confirm(`Drop ${c.short} "${c.subject}"?`, "Drop commit", cx => this.rewrite(`drop ${c.short}`, c, cx, async () => this.todo("replace", c.sha, null, "drop", await this.baseOf(c.sha, 1))), cx), { chip: "drop" });
        add("A", "Amend staged changes into this commit", cx => {
          if (!(this.status?.files ?? []).some(f => f.staged)) { this.flash("Stage something first"); cx.notify(); return; }
          const isHead = c.refs.some(r => r.startsWith("HEAD"));
          this.rewrite(`amend into ${c.short}`, c, cx, async () => isHead ? "git commit --amend --no-edit"
            : `git commit --fixup=${c.sha} && GIT_SEQUENCE_EDITOR=: git rebase -i --autostash --autosquash --rebase-merges ${await this.baseOf(c.sha, 1)}`);
        }, { chip: "amend" });
        add("e", "Edit (stop here in a rebase)", cx => this.rewrite(`edit ${c.short}`, c, cx, async () => this.todo("replace", c.sha, null, "edit", await this.baseOf(c.sha, 1))), { chip: "edit" });
        add("v", "Select a range of commits", cx => { this.rangeAnchor = c.sha; cx.notify(); }, { chip: "range" });
        add("R", "Reword in your editor", cx => this.amendHere(c, "", cx, { title: `reword ${c.short}`, terminal: true }));
        add("a", "Amend author / co-author…", cx => this.openMenu(`Amend ${c.short}'s attributes`, [
          { key: "r", label: "Reset author", hint: "to your git user", run: cx => this.amendHere(c, "--reset-author --no-edit", cx, { title: `reset author of ${c.short}` }) },
          { key: "a", label: "Set author…", hint: "Name <email>", run: cx => this.ask(`Author of ${c.short}`, c.author ?? "", (v, cx) => v && this.amendHere(c, `--author=${q(v)} --no-edit`, cx, { title: `set author of ${c.short}` }), cx, { hint: "Name <email>" }) },
          { key: "c", label: "Add co-author…", hint: "Co-authored-by trailer", run: cx => this.ask(`Co-author of ${c.short}`, "", (v, cx) => v && this.amendHere(c, `--no-edit --trailer ${q(`Co-authored-by: ${v}`)}`, cx, { title: `add co-author to ${c.short}` }), cx, { hint: "Name <email>" }) },
        ], cx));
        add("F", "Create fixup! commit for this commit", cx => {
          if (!(this.status?.files ?? []).some(f => f.staged)) { this.flash("Stage something first"); cx.notify(); return; }
          this.cmd(`git commit --fixup=${c.short}`, `git commit --fixup=${c.sha}`, cx, { term: false });
        });
        add("S", "Squash all fixup! commits above (autosquash)", cx => this.rewrite(`autosquash onto ${c.short}`, c, cx, async () => `GIT_SEQUENCE_EDITOR=: git rebase -i --autostash --autosquash --rebase-merges ${await this.baseOf(c.sha, 1)}`));
        add("space", "Check out this commit (detached)", cx => this.cmd(`git checkout ${c.short}`, `git checkout ${c.sha}`, cx));
        const rows = this.items(), i = this.selIndex();
        const below = rows.slice(i + 1).find(r => r.sha), above = rows.slice(0, i).reverse().find(r => r.sha);
        if (below) add("ctrl-j", "Move commit down", cx => this.rewrite(`move ${c.short} down`, c, cx, async () => { this.sel[this.lk()] = rows.indexOf(below); return this.todo("swap", below.sha, c.sha, null, await this.baseOf(c.sha, 2)); }));
        if (above) add("ctrl-k", "Move commit up", cx => this.rewrite(`move ${c.short} up`, c, cx, async () => { this.sel[this.lk()] = rows.indexOf(above); return this.todo("swap", c.sha, above.sha, null, await this.baseOf(c.sha, 1)); }));
        add("g", "Reset to this commit…", cx => this.openMenu(`Reset ${head} to ${c.short}`, [
          { key: "s", label: "Soft", hint: "keep changes staged", run: cx => this.cmd(`git reset --soft ${c.short}`, `git reset --soft ${c.sha}`, cx, { term: false }) },
          { key: "m", label: "Mixed", hint: "keep changes unstaged", run: cx => this.cmd(`git reset --mixed ${c.short}`, `git reset --mixed ${c.sha}`, cx, { term: false }) },
          { key: "h", label: "Hard", hint: "discard changes", danger: true, run: cx => this.confirm(`Hard reset to ${c.short}? Uncommitted changes are lost.`, "Hard reset", cx => this.cmd(`git reset --hard ${c.short}`, `git reset --hard ${c.sha}`, cx, { term: false }), cx) },
        ], cx));
        add("t", "Revert this commit", cx => this.cmd(`git revert ${c.short}`, `git revert --no-edit ${c.sha}`, cx));
        add("T", "Tag this commit", cx => this.ask(`Tag ${c.short}`, "", (name, cx) => name && this.cmd(`git tag ${name} ${c.short}`, `git tag ${q(name)} ${c.sha}`, cx, { term: false }), cx, { hint: "e.g. v1.2.0" }));
        add("C", this.copied.includes(c.sha) ? "Unmark for cherry-pick" : "Mark for cherry-pick", cx => { this.copied = this.copied.includes(c.sha) ? this.copied.filter(s => s !== c.sha) : [...this.copied, c.sha]; cx.notify(); });
        add("n", "New branch from this commit", cx => this.ask(`New branch from ${c.short}`, "", (name, cx) => name && this.cmd(`git switch -c ${name} ${c.short}`, `git switch -c ${q(name)} ${c.sha}`, cx), cx));
        add("o", "Open in browser", cx => this.commitUrl(c.sha).then(url => url ? exec("open", [url]) : (this.flash("No GitHub/GitLab remote"), cx.notify())));
        add("y", "Copy…", cx => this.copyMenu(c, cx));
      }
      if (this.copied.length) add("V", `Cherry-pick ${this.copied.length} marked onto ${head}`, cx => {
        const order = (this.commits ?? []).filter(r => this.copied.includes(r.sha)).reverse().map(r => r.sha);
        this.cmd(`git cherry-pick ${order.map(s => s.slice(0, 8)).join(" ")}`, `git cherry-pick ${order.join(" ")}`, cx, { after: () => { this.copied = []; } });
      });
    }
    if (sec === "stash" && it) {
      add("space", "Apply", cx => this.cmd(`git stash apply ${it.ref}`, `git stash apply ${q(it.ref)}`, cx, { term: false }));
      add("g", "Pop", cx => this.cmd(`git stash pop ${it.ref}`, `git stash pop ${q(it.ref)}`, cx, { term: false }));
      add("d", "Drop", cx => this.confirm(`Drop ${it.ref} "${it.message}"?`, "Drop stash", cx => this.cmd(`git stash drop ${it.ref}`, `git stash drop ${q(it.ref)}`, cx, { term: false }), cx));
      add("n", "New branch from stash", cx => this.ask(`Branch from ${it.ref}`, "", (name, cx) => name && this.cmd(`git stash branch ${name} ${it.ref}`, `git stash branch ${q(name)} ${q(it.ref)}`, cx), cx));
    }
    // Global, after the section's own so a section key wins. The footer shows the
    // section's own first: what's marked global or custom only lives in x / ?.
    const firstGlobal = A.length;
    if (this.op) add("m", `${this.op.kind}: continue / skip / abort…`, cx => this.opMenu(cx));
    if (this.op && this.conflicts().length) add("v", "Resolve conflicts (chunk picker)", () => this.openConflicts());
    add("i", "Ask AI (conflicts or failed command)", cx => this.askAI(cx));
    add("P", "Push", cx => this.push(cx));
    add("p", "Pull", cx => this.cmd("git pull", "git pull", cx));
    add("c", "Commit", cx => this.commit(cx));
    if ((this.status?.files ?? []).length) add("S", "Stash all changes", cx => this.ask("Stash message (optional)", "", (msg, cx) => this.cmd(`git stash push -u${msg ? ` -m "${msg}"` : ""}`, `git stash push -u${msg ? ` -m ${q(msg)}` : ""}`, cx, { term: false }), cx));
    add("@", "Command log", cx => this.logMenu(cx));
    add("f", "Fetch all remotes", cx => this.cmd("git fetch --all --prune", "git fetch --all --prune", cx, { after: () => { this.prsAt = 0; } }));
    add("ctrl-r", "Refresh", cx => { this.prsAt = 0; this.refresh(cx, true); });
    A.forEach((a, i) => { if (i >= firstGlobal) a.global = true; });
    return A;
  }

  commit(cx) {
    const files = this.status?.files ?? [];
    if (this.conflicts().length) { this.flash("Resolve conflicts first"); cx.notify(); return; }
    // The message is kept per repo (shared "git.commitDrafts", by root) until a commit lands:
    // esc and a failed commit keep it for next time; a commit that moved HEAD clears it.
    const ctx = this.ctx, root = ctx.root;
    const head = () => G.git(ctx, ["rev-parse", "-q", "--verify", "HEAD"]).then(r => r.stdout.trim(), () => "");
    const go = (cx, stageAll) => this.ask("Commit message", commitDraft(root), (msg, cx) => {
      if (!msg) return;
      setCommitDraft(root, msg);
      cx.spawn(async cx => {
        const before = await head();
        const settle = async () => { if ((await head()) !== before) setCommitDraft(root, null); };
        this.cmd(`git commit -m "${msg}"`, `${stageAll ? "git add -A && " : ""}git commit -m ${q(msg)}`, cx, { after: settle, onFail: settle });
      });
    }, cx, { hint: "Summary line", select: false, onClose: text => setCommitDraft(root, text.trim()) });
    const amend = (cx, stageAll) => {
      const head = (this.commits ?? []).find(c => c.refs.some(r => r.startsWith("HEAD")));
      const run = cx => this.cmd("git commit --amend --no-edit", `${stageAll ? "git add -A && " : ""}git commit --amend --no-edit`, cx);
      head && head.state !== "unpushed" && this.tab.commits === 0 ? this.confirm("The last commit is already pushed. Amending needs a force push.", "Amend anyway", run, cx) : run(cx);
    };
    const staged = files.filter(f => f.staged).length, changed = files.filter(f => f.unstaged).length;
    if (!files.length) { this.flash("Nothing to commit"); cx.notify(); return; }
    this.openMenu(`${staged} staged · ${changed} unstaged`, [
      staged > 0 && { key: "c", label: "Commit staged changes", run: cx => go(cx, false) },
      changed > 0 && { key: "a", label: "Stage all and commit", run: cx => go(cx, true) },
      staged > 0 && { key: "A", label: "Amend last commit with staged changes", hint: "keeps message", run: cx => amend(cx, false) },
      changed > 0 && { key: "m", label: "Stage all and amend last commit", hint: "keeps message", run: cx => amend(cx, true) },
      { key: "e", label: "Commit in editor (new tab)", run: () => run("terminal.open", { argv: [this.shell ?? "/bin/zsh", "-lic", "git commit"], folder: this.ctx.root, place: "tab" }) },
    ], cx);
  }

  logMenu(cx) {
    if (!this.log.length) { this.flash("No git commands run yet"); cx.notify(); return; }
    this.openMenu("Command log", this.log.slice(0, 20).map((e, i) => ({
      key: i < 9 ? String(i + 1) : null, label: `${e.running ? "…" : e.code === 0 ? "✓" : "✗"} ${e.title}`,
      hint: e.running ? "running" : `${Math.round((Date.now() - e.at) / 60000) || "now"}${Math.round((Date.now() - e.at) / 60000) ? "m" : ""}`,
      run: cx => e.running && e.addr ? run("terminal.peek", { terminal: e.addr }) : this.showOutput(e, cx),
    })), cx);
  }

  reword(c, cx) {
    cx.spawn(async cx => {
      const full = (await G.git(this.ctx, ["log", "-1", "--format=%B", c.sha]).catch(() => null))?.stdout ?? c.subject;
      const body = full.split("\n").slice(1).join("\n").trim();
      this.ask(`Reword ${c.short}`, c.subject, (msg, cx) => {
        if (!msg || msg === c.subject) return;
        const message = body ? `${msg}\n\n${body}` : msg, isHead = c.refs.some(r => r.startsWith("HEAD"));
        this.rewrite(`reword ${c.short}`, c, cx, async () => isHead ? `git commit --amend --only -m ${q(message)}`
          : `${this.todo("replace", c.sha, null, "edit", await this.baseOf(c.sha, 1))} && git commit --amend --only -m ${q(message)} && git rebase --continue`);
      }, cx);
    });
  }

  // Like lazygit: decide merged-ness ourselves rather than via `git branch -d`, which only checks
  // HEAD/upstream ancestry and so refuses every squash-merged branch.
  deleteLocal(b, cx) {
    const run = cx => this.cmd(`git branch -D ${b.name}`, `git branch -D ${q(b.name)}`, cx, { term: false });
    const pr = this.prs?.[b.name];
    if (b.merged || pr?.state === "MERGED") return run(cx);
    const base = this.base ?? "the base branch";
    this.confirm(`${b.name} is not merged into ${base}. Delete anyway?`, "Force delete (-D)", run, cx,
      [`${b.sha}  ${b.subject}`, pr ? `PR #${pr.number} is ${pr.state.toLowerCase()}` : "No PR found for this branch"]);
  }

  cleanup(cx) {
    const keep = new Set([this.status?.info.head, this.base?.replace(/^[^/]+\//, ""), "main", "master", "develop"]);
    const doomed = (this.branches?.local ?? []).filter(b => !b.head && !keep.has(b.name) && !b.worktree && this.prs?.[b.name]?.state !== "OPEN"
      && (this.prs?.[b.name]?.state === "MERGED" || this.prs?.[b.name]?.state === "CLOSED" || b.gone || b.merged));
    if (!doomed.length) { this.flash("No merged, closed or gone branches"); cx.notify(); return; }
    const why = b => this.prs?.[b.name]?.state?.toLowerCase() ?? (b.gone ? "upstream gone" : "merged");
    this.confirm(`Delete ${doomed.length} local branch${doomed.length > 1 ? "es" : ""}?`, "Delete them (-D)",
      cx => this.cmd(`git branch -D ${doomed.map(b => b.name).join(" ")}`, `git branch -D ${doomed.map(b => q(b.name)).join(" ")}`, cx, { term: false }), cx,
      doomed.slice(0, 14).map(b => `${b.name}  ·  ${why(b)}`).concat(doomed.length > 14 ? [`… and ${doomed.length - 14} more`] : []));
  }

  // ---- Expand / collapse -----------------------------------------------------

  // The side panel's Git becomes a tab of its own (one per space, reused); `git.tab` remembers
  // it and the tab it was opened from, so collapsing can go back there.
  expand(cx) {
    if (!this.ctx) return;
    const space = spaces().find(s => s.active), origin = focused()?.tab, rec = shared("git.tab");
    if (!space) return;
    hidePanel("git");
    if (rec?.space === space.id && space.tabs.some(t => t.id === rec.tab)) {
      setShared("git.tab", { ...rec, origin });
      run("tab.select", { id: rec.tab });
      return;
    }
    const before = new Set(space.tabs.map(t => t.id));
    run("tab.new", { mod: "git", props: { cwd: this.ctx.root, on: this.ctx.on }, name: `Git · ${this.ctx.root.split("/").pop()}` });
    cx.spawn(async cx => {
      let tab = null;
      for (let i = 0; i < 40 && !tab; i++) {
        tab = spaces().find(s => s.id === space.id)?.tabs.find(t => !before.has(t.id))?.id ?? null;
        if (!tab) await cx.sleep(50);
      }
      if (tab) setShared("git.tab", { space: space.id, tab, origin });
    });
  }

  collapse() {
    const rec = shared("git.tab"), space = spaces().find(s => s.active), tab = rec?.tab ?? focused()?.tab;
    revealPanel("git");
    if (rec?.origin && space?.tabs.some(t => t.id === rec.origin)) run("tab.select", { id: rec.origin });
    if (tab) run("tab.close", { id: tab, confirmed: true });
    setShared("git.tab", null);
    setShared("git.tabHasKeys", false);
    run("git.focus");
  }

  // ---- Keys ------------------------------------------------------------------

  // Leaving the panel: left goes straight back to the terminal the keyboard came from (pane.focus);
  // pane.go doesn't reliably move the keyboard out of a panel. Other directions are pane.go's.
  go(dir) {
    this.focusToken = (this.focusToken ?? 0) + 1; // cancel a pending focus retry
    const pane = focused()?.pane;
    if (dir === "left" && pane && !this.fixed) return run("pane.focus", { pane });
    this.handle.focus();
    run("pane.go", { direction: dir });
  }

  // cmd-alt-arrows (keys.json pane.go) are handled here so leaving never depends on pane.go
  // knowing this panel holds the keyboard.
  navKey(e, cx) {
    const m = e.modifiers ?? {};
    if (!(m.platform && m.alt && !m.control && ["left", "right", "up", "down"].includes(e.key))) return false;
    cx.stop_propagation(); this.go(e.key); return true;
  }

  key(e, cx) {
    if (!this.editorFocused && !this.prompt && this.navKey(e, cx)) return;
    if (this.editorFocused) { if (e.key === "escape") { this.handle.focus(); cx.stop_propagation(); } return; }
    if (this.prompt) { if (e.key === "escape") { this.cancelPrompt(cx); cx.stop_propagation(); } return; }
    const k = keyOf(e);
    if (this.menu) { this.menuKey(k, cx); cx.stop_propagation(); return; }
    if (this.handleKey(k, cx)) cx.stop_propagation();
  }

  handleKey(k, cx) {
    if (this.keysOpen) {
      if (k === "escape" || k === "?" || k === "q") { this.keysOpen = false; cx.notify(); }
      return true;
    }
    if (k === "?") { this.keysOpen = true; cx.notify(); return true; }
    if (this.selectedLines().length) {
      if (k === "cmd-c" || k === "ctrl-c") { this.copyLines(cx); return true; }
      if (k === "escape") { this.lineSel = null; cx.notify(); return true; }
    }
    const idx = SECTIONS.findIndex(s => s.id === this.sec);
    const num = SECTIONS.find(s => s.key === k);
    if (num) { this.focusSection(num.id, cx); return true; }
    if (this.mainFocus && (k === "j" || k === "down")) { this.scrollMain(1, cx); return true; }
    if (this.mainFocus && (k === "k" || k === "up")) { this.scrollMain(-1, cx); return true; }
    // shift-↑/↓ on commits: start or grow a range (lazygit).
    if ((k === "shift-down" || k === "shift-up") && this.sec === "commits") {
      if (!this.rangeAnchor && this.selected()?.sha) this.rangeAnchor = this.selected().sha;
      this.move(k === "shift-down" ? 1 : -1, cx); cx.notify(); return true;
    }
    if (k === "escape" && this.rangeRows().length) { this.clearRange(); cx.notify(); return true; }
    switch (k) {
      case "h": case "left": case "shift-tab": this.focusSection(SECTIONS[(idx + SECTIONS.length - 1) % SECTIONS.length].id, cx); return true;
      case "l": case "right": case "tab": this.focusSection(SECTIONS[(idx + 1) % SECTIONS.length].id, cx); return true;
      case "j": case "down": this.move(1, cx); return true;
      case "k": case "up": this.move(-1, cx); return true;
      case "<": case "home": this.move(0, cx, 0); return true;
      case ">": case "end": this.move(0, cx, this.items().length - 1); return true;
      case ",": case "pageup": this.move(-10, cx); return true;
      case ".": case "pagedown": this.move(10, cx); return true;
      case "[": this.switchTab(-1, cx); return true;
      case "]": this.switchTab(1, cx); return true;
      case "ctrl-d": case "J": this.scrollMain(k === "J" ? 3 : 15, cx); return true;
      case "ctrl-u": case "K": this.scrollMain(k === "K" ? -3 : -15, cx); return true;
      case "enter": this.mainFocus = !this.mainFocus; cx.notify(); return true;
      case "escape":
        if (this.mainFocus) this.mainFocus = false;
        else if (this.filter[this.lk()]) this.filter[this.lk()] = "";
        else if (this.mainOverride) { this.mainOverride = null; this.syncMain(cx); }
        else if (this.failure) this.failure = null;
        else return false;
        cx.notify(); return true;
      case "/": {
        const lk = this.lk();
        this.ask(`Filter ${SECTIONS[idx].title.toLowerCase()}`, this.filter[lk] ?? "", (v, cx) => { this.filter[lk] = v; }, cx, { live: (v, cx) => { this.filter[lk] = v; this.sel[lk] = 0; } });
        return true;
      }
      case "q":
        // Like quitting lazygit: put the panel away and give the keyboard back to the terminal.
        if (this.fixed) return false;
        closePanel("git");
        return true;
      case "x": this.openMenu(`${SECTIONS[idx].title} actions`, this.actions().map(a => ({ ...a, hint: a.custom ? "custom" : a.key })), cx); return true;
    }
    const action = this.actions().find(a => a.key === k);
    if (action) { action.run(cx); cx.notify(); return true; }
    return false;
  }

  // ---- Rendering -------------------------------------------------------------

  render(cx) {
    if (JSON.stringify(this.where()) !== this.locKey && !this.refreshing) this.refresh(cx, true);
    this.rangeSet = new Set(this.rangeRows().map(r => r.sha));
    const hasKeys = this.hadKeys = this.keyboard();
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono";
    const width = this.size?.width ?? 400, wide = width >= 720, pane = Boolean(this.fixed);
    const sections = this.ctx ? this.sectionsColumn(t, mono, wide) : null;
    const main = this.ctx ? this.mainView(t, mono) : null;
    const body = !this.ctx
      ? div().flex_1().p(14).text_color(t.dim).child(this.refreshing && !this.locKey ? "Loading…" : `Not a git repository${this.cwd ? `: ${this.cwd}` : ""}`)
      : wide ? h_flex().flex_1().min_h(0).items_stretch().p(6)
        .child(sections.w(this.sizes.cols ?? Math.max(300, Math.min(520, width * 0.42))).flex_none().on_size_change((size) => { this.measured.cols = size.width; }))
        .child(this.resizer("cols", "col", t)).child(main.flex_1())
        : this.mainFocus ? v_flex().flex_1().min_h(0).p(6).child(main.flex_1())
          : v_flex().flex_1().min_h(0).p(6).child(sections.flex_1()).child(this.resizer("main", "row", t))
            .child(main.h(this.sizes.main ?? Math.max(160, (this.size?.height ?? 600) * 0.38)).flex_none().on_size_change((size) => { this.measured.main = size.height; }));
    return v_flex().id("git").relative().size_full().min_h(0).rounded(pane ? 0 : 10).overflow_hidden().bg(t.background).when(!pane, el => el.border_1().border_color(hasKeys ? t.accent : t.border))
      .text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => { if (!this.prompt) this.handle.focus(); })
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_move((e, cx) => this.dragTo(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .child(this.header(t, pane))
      .when(!pane && Boolean(this.repoCfg?.repos.length), el => el.child(this.repoBar(t)))
      .when(Boolean(this.op), el => el.child(this.opBanner(t)))
      .when(Boolean(this.ai), el => el.child(this.aiBanner(t)))
      .child(body)
      .when(Boolean(this.failure) && !this.op, el => el.child(this.failureBanner(t)))
      .child(this.footer(t))
      .when(Boolean(this.menu), el => el.child(this.menuView(t)))
      .when(Boolean(this.prompt), el => el.child(this.promptView(t)))
      .when(Boolean(this.keysOpen), el => el.child(keysCard(t, { id: "git", title: "Git: all keys", groups: this.keysGroups(), onClose: cx => { this.keysOpen = false; cx.notify(); } })));
  }

  keyboard() { return this.handle.is_focused() || Boolean(this.editorFocused || this.typing || this.menu); }

  iconButton(id, icon, action, t, label) {
    return h_flex().id(id).h(24).px(6).gap(4).flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(svg(icon).size(13)).when(Boolean(label), el => el.child(label));
  }

  header(t, pane) {
    const info = this.status?.info, running = this.running, roomy = (this.size?.width ?? 0) >= 560;
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_size(13).child("Git"))
      .when(Boolean(this.ctx), el => el.child(div().text_color(t.dim).truncate().max_w(160).child(this.ctx.root.split("/").pop()))
        .child(h_flex().gap(4).min_w(0).items_center().text_color(t.foreground)
          .child(svg(`${CHROME}/git-branch.svg`).size(12).flex_none().text_color(t.accent))
          .child(div().truncate().child(info?.head === "(detached)" ? `detached @ ${info.oid?.slice(0, 7)}` : info?.head ?? "…")))
        .when(Boolean(info?.upstream), el => el.child(div().flex_none().text_size(11.5).text_color(info.ahead || info.behind ? t.ansi3 : t.ansi2)
          .child(info.ahead || info.behind ? [info.ahead && `↑${info.ahead}`, info.behind && `↓${info.behind}`].filter(Boolean).join(" ") : "✓")))
        .when(Boolean(info?.head) && !info?.upstream && info?.head !== "(detached)", el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("no upstream")))
        .when(Boolean(this.status?.files.length), el => el.child(div().flex_none().text_size(11).text_color(t.ansi3).child(this.treeSummary()))))
      .child(div().flex_1())
      .when(Boolean(running), el => el.child(h_flex().id("git-running").gap(5).min_w(0).items_center().text_size(11.5).text_color(t.working).cursor_pointer()
        .on_click(() => running.addr && run("terminal.peek", { terminal: running.addr }))
        .child(svg(`${CHROME}/spinner.svg`).size(11).flex_none().spin(900)).child(div().truncate().max_w(180).child(running.title))))
      .children([this.selfUpdate.pill(t)].filter(Boolean))
      .when(Boolean(this.ctx) && !running, el => el
        .child(this.iconButton("git-fetch", "mods/git/fetch.svg", cx => this.cmd("git fetch --all --prune", "git fetch --all --prune", cx, { after: () => { this.prsAt = 0; } }), t, roomy && "Fetch"))
        .child(this.iconButton("git-pull", "mods/git/pull.svg", cx => this.cmd("git pull", "git pull", cx), t, roomy && "Pull"))
        .child(this.iconButton("git-push", "mods/git/push.svg", cx => this.push(cx), t, roomy && "Push")))
      .when(Boolean(this.ctx), el => el.child(this.iconButton("git-popout", "mods/git/popout.svg", cx => pane ? this.collapse() : this.expand(cx), t)));
  }

  treeSummary() {
    const f = this.status.files, staged = f.filter(x => x.staged).length, changed = f.filter(x => x.unstaged).length;
    return [staged && `${staged} staged`, changed && `${changed} changed`].filter(Boolean).join(" · ");
  }

  banner(id, color, t, text, buttons) {
    return h_flex().id(id).flex_none().mx(6).mt(6).px(10).py(7).gap(8).items_center().rounded(8).border_1().border_color(color).bg(t.surface)
      .child(div().size(7).flex_none().rounded_full().bg(color))
      .child(div().flex_1().min_w(0).text_size(12).child(text))
      .children(buttons.filter(Boolean).map(([label, action], i) => h_flex().id(`${id}-b${i}`).h(24).px(8).flex_none().items_center().rounded(6).border_1().border_color(t.input)
        .bg(t.raised).text_size(11.5).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { action(cx); cx.notify(); }).child(label)));
  }

  opBanner(t) {
    const op = this.op, n = this.conflicts().length;
    const what = op.kind === "rebase" ? `Rebasing ${op.branch ?? "HEAD"} onto ${op.other ?? "?"}${op.step ? ` · ${op.step}/${op.total}` : ""}`
      : op.kind === "merge" ? `Merging ${op.other ?? "?"} into ${this.status?.info.head ?? "HEAD"}` : `${op.kind} of ${op.other ?? "?"} in progress`;
    return this.banner("op", n ? t.ansi1 : t.ansi3, t, `${what}${n ? ` · ${n} conflict${n > 1 ? "s" : ""}` : " · no conflicts left"}`, [
      n > 0 && ["Resolve (v)", () => this.openConflicts()],
      n > 0 && ["Ask AI (i)", cx => this.askAI(cx)],
      !n && [`Continue`, cx => this.cmd(`git ${op.kind} --continue`, `git ${op.kind} --continue`, cx)],
      ["More (m)", cx => this.opMenu(cx)],
    ]);
  }

  aiBanner(t) {
    const a = this.ai.address ? agents().find(x => x.address === this.ai.address) : null;
    const status = a?.status, color = status === "working" ? t.working : status === "blocked" ? t.blocked : status ? t.ansi2 : t.dim;
    const text = !this.ai.address ? `Started a new agent tab to ${this.ai.label}`
      : !a ? `The agent asked to ${this.ai.label} is gone`
        : status === "working" ? `${a.program?.name ?? "Agent"} (${a.tab_name}) is working on: ${this.ai.label}…`
          : status === "blocked" ? `${a.program?.name ?? "Agent"} needs you (${this.ai.label})`
            : `${a.program?.name ?? "Agent"} finished: review, then ${this.op ? "continue (m)" : "retry"}`;
    return this.banner("ai", color, t, text, [
      a && ["Show", () => run("agent.focus", { terminal: a.address })],
      ["Dismiss", () => { this.ai = null; }],
    ]);
  }

  failureBanner(t) {
    const f = this.failure;
    return this.banner("fail", t.ansi1, t, `${f.title} failed (exit ${f.code})`, [
      ["Output", cx => this.showOutput(f, cx)],
      ["Copy", cx => { cx.write_to_clipboard(`$ ${f.title}\n${f.output}`); this.flash("Output copied"); }],
      ["Ask AI (i)", cx => this.askAI(cx)],
      ["×", () => { this.failure = null; }],
    ]);
  }

  footer(t) {
    const flash = this.flashMsg?.text ?? null;
    return keybar(t, { id: "git", chips: this.chips(), flash, width: this.size?.width, onKeys: cx => { this.keysOpen = true; this.handle.focus(); cx.notify(); } });
  }

  // An action's label as a short keycap label: "New branch from here" → "new branch".
  static short(label) { return label.replace(/…$/, "").toLowerCase().split(" ").slice(0, 2).join(" "); }

  // The footer's keycaps for what's on screen now.
  chips() {
    if (this.prompt) return [{ caps: ["enter"], label: "confirm" }, { caps: ["escape"], label: "cancel" }];
    if (this.menu) return [{ caps: ["j", "k"], label: "move" }, { caps: ["enter"], label: "pick" }, { caps: ["escape"], label: "close" }];
    if (this.editorFocused) return [{ caps: ["cmd-c"], label: "copy" }, { caps: ["escape"], label: "back" }];
    if (this.mainFocus) return [{ caps: ["j", "k"], label: "scroll" }, { caps: ["ctrl-d", "ctrl-u"], label: "page" }, { caps: ["escape"], label: "back" }];
    // The shown section's own actions first (the keybar fits as many as there's room for).
    const all = this.actions().filter(a => a.key !== "ctrl-r");
    const own = all.filter(a => !a.global && !a.custom);
    const acts = (own.length ? own : all).slice(0, 10).map(a => ({ caps: [a.key], label: a.chip ?? Git.short(a.label) }));
    if (this.rangeRows().length > 1) return [{ caps: ["escape"], label: "end range" }, ...acts.filter(a => a.caps[0] !== "v")];
    return [...acts, { caps: ["x"], label: "actions" }];
  }

  keysGroups() {
    const sec = SECTIONS.find(s => s.id === this.sec);
    return [
      { title: `${sec.title}: actions`, chips: this.actions().map(a => ({ caps: [a.key], label: a.label.replace(/…$/, "") })) },
      { title: "Moving", chips: [
        { caps: SECTIONS.map(s => s.key), label: SECTIONS.map(s => s.title.toLowerCase()).join(" / ") },
        { caps: ["h", "l"], label: "previous / next section" },
        { caps: ["j", "k"], label: "move" }, { caps: ["<", ">"], label: "first / last" },
        { caps: [",", "."], label: "page up / down" }, { caps: ["[", "]"], label: "switch tab" },
        { caps: ["enter"], label: "focus the diff" }, { caps: ["J", "K"], label: "scroll the diff" },
        { caps: ["ctrl-d", "ctrl-u"], label: "scroll the diff a page" },
        { caps: ["v"], label: "commits: select a range" }, { caps: ["shift-down", "shift-up"], label: "commits: grow the range" },
      ] },
      { title: "Everywhere", chips: [
        { caps: ["/"], label: "filter" }, { caps: ["x"], label: "actions menu" }, { caps: ["escape"], label: "back / clear" },
        { caps: ["q"], label: "close the panel" }, { caps: ["?"], label: "this card" },
      ] },
    ];
  }

  sectionsColumn(t, mono, wide) {
    return v_flex().min_h(0).children(SECTIONS.filter(s => s.id !== "files" || this.main?.codeRows).flatMap(s => this.collapsed.has(s.id) ? [this.sectionBox(s, t, mono), div().h(6).flex_none()] : [this.sectionBox(s, t, mono), this.resizer(`h:${s.id}`, "row", t)]));
  }

  // A 6px strip that resizes by dragging; a double click puts it back to automatic.
  resizer(key, dir, t) {
    const row = dir === "row";
    return div().id(`resize-${key}`).flex_none().when(row, el => el.h(6).w_full().cursor_row_resize()).when(!row, el => el.w(6).h_full().cursor_col_resize())
      .flex().items_center().justify_center()
      .child(div().rounded(1).when(row, el => el.h(2).w(28)).when(!row, el => el.w(2).h(28))
        .when(this.drag?.key === key, el => el.bg(t.accent)).hover(s => s.bg(t.border)))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count >= 2) { delete this.sizes[key]; localStorage.setItem("sizes", JSON.stringify(this.sizes)); this.drag = null; cx.notify(); return; }
        this.drag = { key, row, from: row ? e.position.y : e.position.x, start: this.sizes[key] ?? this.measured[key] ?? 120 };
        cx.notify();
      });
  }

  dragTo(e, cx) {
    const d = this.drag;
    if (!d) return;
    const delta = (d.row ? e.position.y : e.position.x) - d.from;
    // The main view sits below its handle (narrow), so dragging down shrinks it.
    const size = d.start + (d.key === "main" ? -delta : delta);
    this.sizes[d.key] = Math.round(Math.max(d.key === "cols" ? 240 : 54, Math.min(size, 4000)));
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    localStorage.setItem("sizes", JSON.stringify(this.sizes));
    cx.notify();
  }

  sectionBox(s, t, mono) {
    const shut = this.collapsed.has(s.id);
    const focusedSec = this.sec === s.id, lk = this.lk(s.id), items = this.items(s.id), sel = this.selIndex(s.id), fixed = shut ? null : this.sizes[`h:${s.id}`];
    const count = s.id === "commits" ? items.filter(r => r.sha).length : items.length;
    const head = h_flex().id(`sec-${s.id}`).h(24).flex_none().pl(4).pr(8).gap(6).items_center().cursor_pointer()
      .on_click((_e, cx) => this.focusSection(s.id, cx))
      .child(div().id(`fold-${s.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover(st => st.bg(t.hover).text_color(t.foreground)).tooltip(shut ? `Show ${s.title}` : `Hide ${s.title}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleSection(s.id, cx); })
        .child(svg(`${CHROME}/chevron-${shut ? "right" : "down"}.svg`).size(11)))
      .child(div().text_size(10.5).font_semibold().px(4).rounded(4).bg(focusedSec && this.hadKeys ? t.accent : t.raised).text_color(focusedSec && this.hadKeys ? t.accent_foreground : t.muted).child(s.key))
      .child(div().font_semibold().text_color(focusedSec ? t.foreground : t.muted).child(s.title))
      .when(Boolean(s.tabs), el => el.children(s.tabs.map((name, i) => div().id(`tab-${s.id}-${i}`).px(5).rounded(4).text_size(11)
        .text_color(this.tab[s.id] === i ? t.foreground : t.dim).when(this.tab[s.id] === i, d => d.bg(t.raised))
        .on_click((_e, cx) => { cx.stop_propagation(); if (this.tab[s.id] !== i) { this.sec = s.id; this.switchTab(i - this.tab[s.id], cx); } }).child(name))))
      .when(Boolean(this.filter[lk]), el => el.child(div().text_size(11).text_color(t.accent).truncate().child(`/${this.filter[lk]}`)))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(String(count)));
    const row = (it, i, inList) => this.row(s.id, it, i, i === sel, focusedSec, t, mono, inList);
    if (shut) return v_flex().id(`box-${s.id}`).flex_none().rounded(8).border_1().border_color(focusedSec && this.hadKeys ? t.accent : t.border).child(head);
    let body;
    if (!items.length) body = div().px(10).h(ROW).flex_none().flex().items_center().text_size(11.5).text_color(t.dim).child(this.emptyText(s.id));
    else if (focusedSec) {
      const id = `list-${lk}`;
      body = div().flex_1().min_h(0).relative()
        .child(div().size_full().child(v_virtual_list(id, items.length, ROW, i => this.itemKey(s.id, items[i], i), range => items.slice(range.start, range.end).map((it, j) => row(it, range.start + j, true)))
          .track_scroll(this.scrolls[lk]).size_full()
          .on_item_click((key, cx) => this.clickRow(s.id, items.findIndex((it, j) => this.itemKey(s.id, it, j) === key), cx))))
        .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
    } else {
      const fit = fixed ? Math.max(1, Math.floor((fixed - 30) / ROW)) : s.cap;
      const cap = Math.min(fit, items.length), start = Math.max(0, Math.min(sel - Math.floor(cap / 2), items.length - cap));
      body = v_flex().flex_none().children(items.slice(start, start + cap).map((it, j) => row(it, start + j)));
    }
    return v_flex().id(`box-${s.id}`).min_h(0).rounded(8).border_1().border_color(focusedSec && this.hadKeys ? t.accent : t.border).pb(4)
      .when(Boolean(fixed), el => el.h(fixed).flex_none().overflow_hidden())
      .when(!fixed && focusedSec, el => el.flex_1()).when(!fixed && !focusedSec, el => el.flex_none())
      .on_size_change((size) => { this.measured[`h:${s.id}`] = size.height; })
      .child(head).child(body);
  }

  emptyText(sec) {
    if (sec === "files") return this.main?.codeRows ? "No changed files" : "Pick a PR, branch or commit to see its files";
    if (sec === "branches" && this.tab.branches === 0) return this.prList ? "No pull requests" : this.prsFailed ? "Couldn't list pull requests (is gh installed and logged in?)" : "Loading pull requests…";
    return { branches: "No branches", commits: "No commits", stash: "No stashes" }[sec];
  }

  itemKey(sec, it, i) {
    if (sec === "files") return `f${it.path}`;
    return sec === "branches" ? (it.kind === "pr" ? `p${it.number}` : `b${it.name}`) : sec === "commits" ? it.sha : `s${it.ref}`;
  }

  // Virtual-list rows can't carry handlers, so a second click on the same row within 400 ms counts as a double click.
  clickRow(sec, i, cx) {
    if (i < 0) return;
    const now = Date.now(), double = this.lastClick?.sec === sec && this.lastClick.i === i && now - this.lastClick.at < 400;
    this.lastClick = { sec, i, at: now };
    if (this.sec !== sec) this.focusSection(sec, cx);
    this.move(0, cx, i);
    if (double) this.actions().find(a => a.key === "space")?.run(cx);
    cx.notify();
  }

  row(sec, it, i, selected, focusedSec, t, mono, inList) {
    // In a commit range (v): drawn like the selected row.
    const picked = !selected && sec === "commits" && Boolean(it.sha) && Boolean(this.rangeSet?.has(it.sha));
    const el = h_flex().id(`${sec}-${this.itemKey(sec, it, i)}`).h(ROW).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer().min_w(0)
      .when(selected || picked, e => e.bg(focusedSec ? t.selected : t.hover))
      .hover(s => s.bg(selected && focusedSec ? t.selected : t.hover))
      .when(!inList, e => e.on_click((_e, cx) => this.clickRow(sec, i, cx)));
    if (sec === "branches") return it.kind === "pr" ? this.prRow(el, it, t) : this.branchRow(el, it, t);
    if (sec === "commits") return this.commitRow(el, it, t, mono);
    if (sec === "files") return this.fileRow(el, it, t);
    return el.child(div().flex_none().text_color(t.dim).font_family(mono).text_size(11.5).child(it.ref.replace("stash@", "")))
      .child(div().flex_1().min_w(0).truncate().child(it.message)).child(div().flex_none().text_size(11).text_color(t.dim).child(it.date));
  }

  branchRow(el, b, t) {
    const remote = b.kind === "remote", pr = this.prs?.[remote ? b.short : b.name];
    const stale = !remote && !b.head && (pr?.state === "MERGED" || pr?.state === "CLOSED" || b.gone);
    const badge = (text, color) => div().flex_none().px(4).rounded(4).border_1().border_color(color).text_size(10.5).text_color(color).child(text);
    return el.child(div().w(10).flex_none().text_color(t.accent).child(b.head ? "*" : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(b.head ? t.accent : stale ? t.dim : t.foreground).when(b.head, d => d.font_semibold()).child(b.name))
      .when(Boolean(pr), e => e.child(badge(`#${pr.number} ${pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`, pr.isDraft && pr.state === "OPEN" ? t.dim : t[PR_COLOR[pr.state]] ?? t.dim)))
      .when(!remote, e => e.child(
        b.gone ? badge("gone", t.ansi1)
          : !b.upstream ? badge("local", t.dim)
            : b.ahead || b.behind ? div().flex_none().text_size(11).text_color(t.ansi3).child(`${b.ahead ? `↑${b.ahead}` : ""}${b.behind ? `↓${b.behind}` : ""}`)
              : div().flex_none().text_size(11).text_color(t.ansi2).child("✓")))
      .when(!remote && b.merged && !pr && !b.head && b.name !== this.base?.replace(/^[^/]+\//, ""), e => e.child(badge("merged", t.ansi5)))
      .when(!remote && Boolean(b.worktree), e => e.child(badge("worktree", t.dim)))
      .when(remote && Boolean(b.local), e => e.child(badge(`local: ${b.local === b.short ? "✓" : b.local}`, t.ansi2)))
      .when((this.size?.width ?? 0) >= 520, e => e.child(div().flex_none().text_size(11).text_color(t.dim).child(b.date.replace(/ ago$/, ""))));
  }

  fileRow(el, f, t) {
    const [mark, color] = f.status === "new" ? ["A", t.ansi2] : f.status === "deleted" ? ["D", t.ansi1] : f.from ? ["R", t.ansi4] : ["M", t.ansi3];
    const slash = f.path.lastIndexOf("/"), dir = slash >= 0 ? f.path.slice(0, slash + 1) : "", base = f.path.slice(slash + 1);
    return el.child(div().w(12).flex_none().text_size(11).font_semibold().text_color(color).child(mark))
      .child(h_flex().flex_1().min_w(0).overflow_hidden()
        .child(div().flex_none().text_color(t.foreground).child(base))
        .when(Boolean(dir), e => e.child(div().min_w(0).pl(6).truncate().text_size(11).text_color(t.dim).child(dir))))
      .when(f.add > 0, e => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, e => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  prRow(el, pr, t) {
    const draft = pr.isDraft && pr.state === "OPEN", done = pr.state !== "OPEN";
    const badge = (text, color) => div().flex_none().px(4).rounded(4).border_1().border_color(color).text_size(10.5).text_color(color).child(text);
    const review = { APPROVED: ["✓", t.ansi2, "Approved"], CHANGES_REQUESTED: ["✗", t.ansi1, "Changes requested"] }[pr.reviewDecision];
    const days = (Date.now() - new Date(pr.updatedAt).getTime()) / 86400000;
    const age = !Number.isFinite(days) ? "" : days < 1 / 24 ? `${Math.max(1, Math.round(days * 1440))}m` : days < 1 ? `${Math.round(days * 24)}h` : `${Math.round(days)}d`;
    const wide = (this.size?.width ?? 0) >= 520;
    return el.child(div().w(42).flex_none().text_size(11.5).text_color(t.dim).child(`#${pr.number}`))
      .child(div().flex_1().min_w(0).truncate().text_color(done ? t.dim : t.foreground).child(pr.title))
      .when(wide && Boolean(pr.author?.login), e => e.child(div().flex_none().text_size(11).text_color(t.dim).child(pr.author.login)))
      .when(Boolean(review), e => e.child(div().id(`pr-review-${pr.number}`).flex_none().text_size(11.5).text_color(review[1]).tooltip(review[2]).child(review[0])))
      .child(badge(draft ? "draft" : pr.state.toLowerCase(), draft ? t.dim : t[PR_COLOR[pr.state]] ?? t.dim))
      .when(wide && Boolean(age), e => e.child(div().flex_none().text_size(11).text_color(t.dim).child(age)));
  }

  palette(t) { return [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1, t.ansi12 ?? t.ansi4, t.ansi13 ?? t.ansi5]; }

  commitRow(el, c, t, mono) {
    const hashColor = c.state === "unpushed" ? t.ansi1 : c.state === "pushed" ? t.ansi3 : t.ansi2;
    const refs = c.refs.map(r => r.replace(/^HEAD -> /, "→ ")).filter(r => r !== "HEAD" && !r.endsWith("/HEAD"));
    const isHead = c.refs.some(r => r.startsWith("HEAD"));
    return el.child(graphCell(c.lane, ROW, this.palette(t), t.background, { highlight: isHead ? t.foreground : null }))
      .child(div().flex_none().font_family(mono).text_size(11.5).text_color(hashColor).child(c.short))
      .when(this.copied.includes(c.sha), e => e.child(div().flex_none().text_size(10.5).text_color(t.ansi6).child("⎘")))
      .children(refs.slice(0, 2).map(r => div().flex_none().max_w(140).truncate().px(4).rounded(4).text_size(10.5)
        .bg(r.startsWith("→") ? t.accent : t.raised).text_color(r.startsWith("→") ? t.accent_foreground : r.startsWith("tag:") ? t.ansi3 : t.ansi6).child(r)))
      .when(refs.length > 2, e => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${refs.length - 2}`)))
      .child(div().flex_1().min_w(0).truncate().text_color(c.state === "merged" ? t.muted : t.foreground).child(c.subject))
      .when((this.size?.width ?? 0) >= 520, e => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${c.author.split(" ")[0]} · ${c.date.replace(/ ago$/, "")}`)));
  }

  // Code rows picked by click / shift-click in the Code view, as [first, last] indices, or [].
  selectedLines() {
    const m = this.main, sel = this.lineSel;
    if (!sel || !m?.codeRows || m.rows !== m.codeRows || sel.key !== m.key) return [];
    return [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
  }

  clickLine(i, cx) {
    const m = this.main, r = m?.rows?.[i];
    if (!r || m.rows !== m.codeRows) return;
    if (r.kind === "card") { cx.write_to_clipboard(r.path); this.flash(`Copied ${r.path}`); cx.notify(); return; }
    if (r.kind === "gap") return;
    const [lo, hi] = this.selectedLines();
    if (this.shiftPress && lo != null) this.lineSel = { ...this.lineSel, b: i };
    else this.lineSel = lo === i && hi === i ? null : { key: m.key, a: i, b: i };
    cx.notify();
  }

  // As a file:lines header and a diff block per file, ready to paste into an agent.
  copyLines(cx) {
    const [lo, hi] = this.selectedLines(), rows = this.main.codeRows;
    if (lo == null) return;
    let card = null;
    for (let i = lo; i >= 0; i--) if (rows[i].kind === "card") { card = rows[i]; break; }
    const groups = [];
    for (let i = lo; i <= hi; i++) {
      const r = rows[i];
      if (r.kind === "card") { card = r; continue; }
      if (!r.inCard) continue;
      if (groups.at(-1)?.card !== card) groups.push({ card, rows: [] });
      groups.at(-1).rows.push(r);
    }
    const text = groups.map(g => {
      const nums = g.rows.map(r => r.new ?? r.old).filter(n => n != null);
      const span = nums.length ? (Math.min(...nums) === Math.max(...nums) ? `:${nums[0]}` : `:${Math.min(...nums)}-${Math.max(...nums)}`) : "";
      return `${g.card?.path ?? ""}${span}\n\`\`\`diff\n${g.rows.map(r => r.text).join("\n")}\n\`\`\``;
    }).join("\n\n");
    cx.write_to_clipboard(text);
    const n = groups.reduce((sum, g) => sum + g.rows.length, 0);
    this.flash(`Copied ${n} line${n === 1 ? "" : "s"}`);
    cx.notify();
  }

  mainView(t, mono) {
    const m = this.main, log = m?.log;
    let head = h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.mainFocus ? t.foreground : t.muted)
        .child(log ? `${log.running ? "running" : log.code === 0 ? "✓" : `✗ exit ${log.code}`} · ${log.title}` : m?.title ?? ""))
      .when(this.selectedLines().length > 0, el => {
        const [lo, hi] = this.selectedLines(), n = m.codeRows.slice(lo, hi + 1).filter(r => r.inCard).length;
        return el.child(div().flex_none().text_size(11).text_color(t.accent).child(`${n} line${n === 1 ? "" : "s"} selected`))
          .child(this.iconButton("main-copy-lines", "mods/git/copy.svg", cx => this.copyLines(cx), t, "Copy"))
          .child(this.iconButton("main-clear-lines", `${CHROME}/x.svg`, cx => { this.lineSel = null; cx.notify(); }, t));
      })
      .when(Boolean(log), el => el
        .when(Boolean(log.running && log.addr), e => e.child(this.iconButton("main-peek", `${CHROME}/terminal.svg`, () => run("terminal.peek", { terminal: log.addr }), t, "Watch")))
        .child(this.iconButton("main-copy", "mods/git/copy.svg", cx => { cx.write_to_clipboard(`$ ${log.title}\n${log.output}`); this.flash("Output copied"); }, t, "Copy"))
        .when(!log.running && log.code !== 0, e => e.child(this.iconButton("main-ai", "mods/git/ai.svg", cx => this.askAI(cx), t, "Ask AI"))));
    const tabs = m?.codeRows ? h_flex().flex_none().gap(6).p(6).border_b(1).border_color(t.border).children([["commit", m.commitLabel ?? "Commit"], ["code", `Code${m.codeRows.length ? ` · ${m.codeRows.filter(r => r.kind === "card").length} files` : ""}`]].map(([id, label]) => {
      const on = (this.mainTab ?? "code") === id;
      return h_flex().id(`main-tab-${id}`).flex_1().h(30).items_center().justify_center().rounded(6).border_1().text_size(12.5).cursor_pointer()
        .border_color(on ? t.accent : t.border).bg(on ? t.raised : t.background).text_color(on ? t.foreground : t.muted)
        .when(on, e => e.font_semibold()).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.setMainTab(id, cx); }).child(label);
    })) : null;
    const box = v_flex().min_h(0).min_w(0).rounded(8).border_1().border_color(this.mainFocus && this.hadKeys ? t.accent : t.border).overflow_hidden().child(head).when(Boolean(tabs), el => el.child(tabs));
    if (!m) return box.child(div().p(10).text_color(t.dim).child("Nothing selected"));
    if (log) return box.child(div().id("main-editor").flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Editor.new(this.editor).size_full()));
    if (!m.rows) return box.child(div().p(10).text_color(t.dim).child("Loading…"));
    if (m.commits) return box.child(div().flex_1().min_h(0).relative().px(4)
      .child(v_virtual_list("main-commits", m.commits.length, ROW, i => m.commits[i].sha,
        range => m.commits.slice(range.start, range.end).map(c => this.commitRow(h_flex().h(ROW).flex_none().px(6).gap(6).items_center().min_w(0), c, t, mono)))
        .track_scroll(this.scrolls.main).size_full())
      .child(Scrollbar.vertical("main-commits").viewport_from_layout().absolute().inset_0()));
    const palette = { add: [t.ansi2, t.ansi2 + "18"], del: [t.ansi1, t.ansi1 + "18"], hunk: [t.ansi6, t.raised], file: [t.foreground, null], meta: [t.ansi3, null] };
    const cardSide = el => el.mx(8).border_l(1).border_r(1).border_color(t.border);
    const coded = m.rows === m.codeRows, [selLo, selHi] = this.selectedLines();
    const gutter = n => div().w(36).flex_none().pr(6).text_right().text_color(t.dim).child(n == null ? "" : String(n));
    const line = (r, i) => {
      if (r.kind === "gap") return div().h(LINE).flex_none();
      if (r.kind === "card") {
        const one = r.last === r;
        return cardSide(h_flex().h(LINE).flex_none().px(10).gap(8).items_center().whitespace_nowrap().bg(t.raised).border_t(1).rounded_t(6))
          .when(one, e => e.border_b(1).rounded_b(6)).font_semibold()
          .child(div().text_color(t.foreground).child(r.from ? `${r.from} → ${r.path}` : r.path))
          .when(Boolean(r.status), e => e.child(div().text_size(10.5).text_color(r.status === "new" ? t.ansi2 : t.ansi1).child(r.status)))
          .when(r.add > 0, e => e.child(div().text_color(t.ansi2).child(`+${r.add}`)))
          .when(r.del > 0, e => e.child(div().text_color(t.ansi1).child(`-${r.del}`)))
          .child(svg("mods/git/copy.svg").size(11).flex_none().text_color(t.dim));
      }
      const [fg, bg] = palette[r.kind] ?? [t.foreground, null];
      const picked = coded && selLo != null && i >= selLo && i <= selHi && r.inCard;
      const el = coded && r.inCard
        ? h_flex().h(LINE).flex_none().pr(10).whitespace_nowrap().text_color(fg).when(Boolean(bg), e => e.bg(bg)).when(picked, e => e.bg(t.selected))
          .child(gutter(r.old)).child(gutter(r.new)).child(div().pl(6).child(r.text || " "))
        : div().h(LINE).flex_none().px(10).whitespace_nowrap().text_color(fg).when(Boolean(bg), e => e.bg(bg)).when(r.kind === "file", e => e.font_semibold()).child(r.text || " ");
      return r.inCard ? cardSide(el).when(Boolean(r.last), e => e.border_b(1).rounded_b(6)) : el;
    };
    if (m.codeRows && !m.rows.length) return box.child(div().p(10).text_color(t.dim).child(m.rows === m.codeRows ? m.emptyCode ?? "No code changes in this commit" : m.emptyCommit ?? "Nothing to show"));
    return box.child(div().flex_1().min_h(0).relative().font_family(mono).text_size(12)
      .child(div().id("main-x").size_full().overflow_x_scrollbar()
        .on_mouse_down("left", e => { this.shiftPress = Boolean(e.modifiers?.shift); })
        .child(div().w_full().min_w(m.width + (coded ? 84 : 0)).h_full().child(v_virtual_list("main-lines", m.rows.length, LINE, i => String(i),
          range => m.rows.slice(range.start, range.end).map((r, j) => line(r, range.start + j))).track_scroll(this.scrolls.main).size_full()
          .on_item_click((key, cx) => this.clickLine(Number(key), cx)))))
      .child(Scrollbar.vertical("main-lines").viewport_from_layout().absolute().inset_0()));
  }

  menuView(t) {
    const m = this.menu;
    return div().id("menu-scrim").absolute().inset_0().bg("#00000055").flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.menu = null; cx.notify(); })
      .child(v_flex().id("menu").w(380).max_h(520).p(6).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().px(8).py(6).font_semibold().child(m.title))
        .when(Boolean(m.lines?.length), el => el.child(v_flex().px(8).pb(6).text_size(11.5).text_color(t.muted).children(m.lines.map(l => div().truncate().child(l)))))
        .child(v_flex().id("menu-items").overflow_y_scrollbar().children(m.items.map((it, i) => h_flex().id(`mi-${i}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6)
          .when(!it.disabled, e => e.cursor_pointer()).when(i === m.sel, e => e.bg(t.selected)).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { if (it.disabled) return; this.menu = null; it.run(cx); cx.notify(); })
          .child(div().w(46).flex_none().text_size(11).font_family(settings().font_family ?? "JetBrains Mono").text_color(t.accent).child(it.key ?? ""))
          .child(div().flex_1().min_w(0).truncate().text_color(it.disabled ? t.dim : it.danger ? t.ansi1 : t.foreground).child(it.label))
          .when(Boolean(it.hint) && it.hint !== it.key, e => e.child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint)))))));
  }

  promptView(t) {
    const p = this.prompt;
    return div().id("prompt-scrim").absolute().inset_0().bg("#00000055").flex().items_start().justify_center().pt(70)
      .child(v_flex().id("prompt").w(420).p(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().font_semibold().child(p.title))
        .child(Input.new(p.input).h(32).px(10).rounded(7).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(div().text_size(11).text_color(t.dim).child("enter confirm · esc cancel")));
  }
}

function cx_open(view, paths) {
  const editor = view.config?.editor ? q(view.config.editor) : "${VISUAL:-${EDITOR:-vi}}";
  run("terminal.open", { argv: [view.shell ?? "/bin/zsh", "-lic", `${editor} ${[paths].flat().map(q).join(" ")}`], folder: view.ctx.root, place: "tab" });
}
