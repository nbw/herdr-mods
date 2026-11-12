# Pond

Herdr's own `main` window, with a fuller right-hand panel and a few personal swaps. The left
sidebar keeps the spaces list, but its agents list shows animated ducks and Claude's context
use. The tab bar gains Git, Skills, Todos, Servers and PR buttons next to Files and Changes, each
opening its own panel on the right: a lazygit-style git panel, Claude skills, Markdown todo
pages, a dev-server runner and the focused branch's GitHub pull request. Files is keyboard-driven (vim keys), and Changes is the
third-party gitview instead of Herdr's stock panel.


**Install:** Point your Herdr agent at this folder: copy `layouts/pond.json` to
`~/.config/herdr-app/layouts/` and every folder in `mods/` (`pond-agents`, `pond-files`, `pond-tabs`,
`git`, `git-conflicts`, `skills`, `todos`, `servers`, `remote-checker`, `pond-profiles`) to `~/.config/herdr-app/mods/`, renaming any that clash
(and the `mod` names in the layout), run `herdr-app check ~/.config/herdr-app/mods/<name>` on
each, install and patch gitview (below), then `herdr-app do layout.switch --name pond`.

**Version:** 1.3.0 (see Changes at the end; also `"version"` in `layouts/pond.json`, and each mod's own in its `mod.json`).

**Update:** tell your Herdr agent "update my herdr mods" (or "update pond mods"). It follows `UPDATE.md`, installed in the mod folder, which checks this repo's `versions.json` and offers every newer version of the mods and layouts you have from here, with a backup of each. By hand: replace `layouts/pond.json` and each folder in `mods/` with this folder's copies (asking an agent to *install* again adds second copies instead). Sizes and panels you clicked are kept (Herdr keeps them in `layouts/.state/`), and so are the mods' settings and data; edits you made inside `pond.json` or the mod folders are not. Reapply the gitview patch if gitview updated too.

## What you see

Left to right; no system title bar (macOS traffic lights at 12,16); `canvas` behind
everything; 1px `border` dividers; terminals padded 14x12.

- **Sidebar**, 268px on `chrome` (44–480px, edge not draggable), top to bottom:
  - brand bar, 46px (shipped `workspace-chrome`), drags the window;
  - spaces list (shipped `spaces`) and agents list (`pond-agents`), sharing the height equally,
    each at least 90px. Agents rows are 66px with a 45px pixel duck (or the space's chosen figure set) acting out the status
    and, for Claude Code, a green/yellow/red context bar and the model;
  - footer, 69px (`workspace-chrome` with `footer: true`).
- **Work column**, the rest:
  - tab bar, 42px (`pond-tabs`), drags the window: tab pills, `+` menu, then panel buttons
    Files, Changes, Git, Skills, Todos, Servers, PR (26px, 12px text; `selected` when open).
    Servers shows a green (`ansi2`) count of running servers;
  - body row with 8px padding and 8px gap:
    - the active tab's panes as cards: `background`, 1px `border` (`accent` when focused),
      radius 10, 8px apart, framed even when alone, each with the shipped `pane` header (30px, top);
    - the panel, 368px (280–900), hidden until a panel button opens it: a stack showing one of
      `files` (`pond-files`), `changes` (`gitview`), `git`, `skills`, `todos`, `servers`,
      `remote` (`remote-checker`), `profiles` (`pond-profiles`);
  - status bar, 28px (shipped `workspace-status`).

## How it behaves

- Agent statuses in the agents list: working = duck jabbing a knife + `working` spinner;
  blocked = angry duck (scowling after 1 min) + "Needs you" pill in `blocked`; done = blushing
  duck hopping + `done` dot; idle = blushing duck bobbing + `idle` ring. Tabs in the bar show a
  spinner while working and a 6px `blocked`/`done` dot.
- A panel button runs `layout.select {stack: "panel-body", child}` + `layout.show {id: "panel"}`;
  clicking the open one runs `layout.hide`. The open panel is remembered per space.
- Files, Git, Skills, Todos, Servers, Remote Checker and gitview are `focusable`: `pane.go` moves the keyboard
  into them, the border turns accent, a keycap footer lists their keys and `?` shows them all.
- Git: lazygit-style sections and vim keys; writes run in core terminals with a log; conflicts
  and failures can be handed to an agent, and `v` opens a Conflicts pane (`git-conflicts`) beside the
  tab with a lazygit-style chunk picker (see the `git` item's recipe). Skills: `~/.claude/skills` and the repo's
  `.claude/skills`; run one in an agent here or a new tab, edit in nvim, scaffold a new one.
  Todos: pages of `- [ ]` items saved at once as Markdown in `~/.config/herdr-app/todos`.
  Servers: dev servers saved in `~/.config/herdr-app/servers.json`, each run as a core terminal
  labeled `herdr.server`, so they outlive the app. PR (`remote-checker`): the focused branch's
  GitHub pull request (checks, reviewers, comments, diff, commits) through `gh`, every 10s while open.
- Sidebar folding (`layout.toggle sidebar`) and the narrow rail work as in shipped `main`.

## Built from

Clone of shipped `layouts/main.json` (`cloned_from: {name: "main", version: "0.1.13"}`);
keys are reordered but the tree, ids, sizes and look are the shipped ones except:

| Node | Shipped | pond |
|---|---|---|
| `agents` block | `agents` | `pond-agents` (ducks, context bar) |
| `tabs` block | `tabs` | `pond-tabs` (5 extra panel buttons, Servers badge) |
| `files` (stack child) | `files` | `pond-files` (vim keys, keybar, plain-text preview) |
| `changes` (stack child) | `changes` | `gitview`, props `{ "replaces": { "mod": "changes" } }` |
| `panel-body` stack | 2 children | + `git`, `skills`, `todos`, `servers`, `remote` (`remote-checker`), `profiles` (`pond-profiles`) blocks |

Tree: `root` row → `sidebar` column [`brand`, `sidebar-lists` column [`spaces`, `agents`],
`sidebar-footer`] + `work` column [`tabs`, `work-body` row [`main` (`tab: active` with the
pane frame), `panel` column [`panel-body` stack, `active: files`]], `status`].

Mods: shipped `workspace-chrome`, `spaces`, `pane`, `workspace-status` (and the `new-menu`,
`files`/`changes` icons `pond-tabs` borrows); this repo's ten in `mods/` (`git-conflicts` belongs with `git`); `gitview` from
outside. `pond-agents` and `pond-files` have their own recipes in this repo; `pond-tabs` differs from
shipped `tabs` only by the five buttons (`enabled` always adds `git`, `skills`, `todos`,
`servers`, `remote` to shared `workspace.panels`) and its own `mods/pond-tabs/win-*.svg` paths.
Programs the panels run: `git`, `sh`, `hc`, `nvim` (git and skills), `mv` (todos), `gh` (remote-checker), `python3`, `cvm`, `claude` (pond-profiles; see its recipe).

**gitview** (github.com/ChmaraX/herdr-gitview, not in this repo): install it with that repo's
instructions. It brings several `gitview*` mod folders plus a `herdr-gitview` engine binary
the panel runs for git. The `replaces` prop is a marker for its installer; gitview doesn't
read it. Without gitview the Changes button still opens the `changes` slot, but the block names
a mod that doesn't exist and stays empty (see `herdr-app status`). To use Herdr's stock panel
instead, set that block's `content` to `{ "mod": "changes" }`.

**Patch gitview** after installing it (gitview's own files; reapply after every gitview update).
Stock gitview never says when its file list has the keyboard, and the `leader` mod needs that.
In `mods/gitview/main.js`, `init()` already has a `cx.timer.every(300, …)` (it handles `reviveAt` and
`stale()`). At the top of that callback, add:

```js
// LOCAL PATCH (not upstream): tell the leader mod when the list has the keys.
const keys = this.handle.is_focused() || Boolean(this.typing);
if (keys !== this.sharedKeys) { this.sharedKeys = keys; setShared("gitview.hasKeys", keys); }
```

Also add `setShared` to that file's `herdr` import if it isn't there. If upstream has renamed `this.handle` (the list's focus handle) or `this.typing` (set while
a prompt or commit message takes typing), use what replaced them. Without the patch, the
leader can't tell that Changes holds the keyboard:
- leader `h` from Changes falls back to the generic move. The keyboard then goes to the terminal and is lost again, because the popup's
  close sends `focus` back to gitview and gitview's focus loop grabs it.
- leader `e` treats Changes as a terminal, so it doesn't open `gitview-tab`.

Everything else (entering Changes with `pane.go`, moving before closing the popup) lives in `leader`;
gitview needs no other change.

## Watch out

- Keep the node ids `sidebar`, `panel`, `panel-body` and the child ids `files`, `changes`,
  `git`, `skills`, `todos`, `servers`: `pond-tabs` selects stack children by id, the agents rail
  measures `sidebar`, and Files' `q` hides `panel`.
- Renaming mods on a clash: `git` reads `mods/git/config.json` and `mods/git/seq-edit.pl`
  by fixed path, and `pond-tabs` draws `mods/skills/skills.svg`, `mods/todos/todos.svg`; rename
  those paths too. The `leader` mod (separate item) looks for `<mod>.hasKeys` by these names.
- `git/config.json` ships this author's settings: editor `nvim` and a `ctrl-p` custom command
  that prunes local branches whose upstream is gone. Review before using.
- Assumptions: projects live in `~/code` (the Servers add-folder picker; changeable there with Change…), Claude skills in
  `~/.claude/skills`, deleted todo pages go to `~/.Trash` (macOS), `nvim` is installed.
- The context bar needs a Claude Code status line that runs
  `hc label "$HC_TERMINAL_ID" claude.context=<pct> claude.model=<name>`; not included here.
- The panel buttons for Git/Skills/Todos/Servers always show, even if the mods are missing.
- My own copy has a system-stats strip between the lists and the footer, from a third-party mod that
  isn't in this repo: github.com/DarkoKuzmanovic/herdr-mods (`sysstat`, Linux `/proc`; mine is a local
  version with a macOS fallback and a two-row `stacked` prop). It's cut from the published layout. To
  add it, install that mod and put this after the `sidebar-lists` node in `sidebar`:
  `{ "id": "sysstat", "type": "block", "content": { "mod": "sysstat", "props": { "stacked": true } }, "size": { "px": 44 } }`.

## Done when

- Every mod in `mods/` passes `herdr-app check`; `layout.switch --name pond` shows a 268px
  sidebar (brand, spaces, duck agents list, footer), a 42px tab bar and a 28px status bar.
- The tab bar shows Files, Changes, Git, Skills, Todos, Servers; each opens a 368px panel on the
  right with that mod, and clicking it again hides the panel.
- A working agent's duck jabs a knife; a blocked one shows "Needs you".
- With gitview installed, Changes shows gitview's file list for the space's repo.
- With the gitview patch: while Changes has the keyboard, `shared.json` has `"gitview.hasKeys": true`,
  and after leader `h` from Changes the terminal has the keyboard and keeps it.
- Starting a server from Servers raises the green count on its button.
- `layout.switch` (`ctrl-shift-l` by default) cycles back to the previous layout.

## Changes

### 1.3.0 (2026-11-12)

- pond-profiles 1.2.0 (✕ in setup goes back to the panel). Mods at: pond-agents 1.1.1, pond-tabs 1.1.0, servers 1.0.1, pond-profiles 1.2.0; others 1.0.0.

### 1.2.0 (2026-11-12)

- pond-profiles 1.1.0 (edit profile variables, optional status line for context bars), pond-agents 1.1.1 (badges without a status line). Mods at: pond-agents 1.1.1, pond-tabs 1.1.0, servers 1.0.1, pond-profiles 1.1.0; others 1.0.0.

### 1.1.1 (2026-11-12)

- pond-profiles 1.0.1 (setup's PATH step). Mods at: pond-agents 1.1.0, pond-tabs 1.1.0, servers 1.0.1, pond-profiles 1.0.1; others 1.0.0.

### 1.1.0 (2026-11-12)

- Claude profiles panel (`pond-profiles` 1.0.0, panel child `profiles`) with an account button on the tab bar and account badges in the agents list. Mods at: pond-agents 1.1.0, pond-tabs 1.1.0, servers 1.0.1, pond-profiles 1.0.0; others unchanged (1.0.0).

### 1.0.1 (2026-11-11)

- The system-stats block (`sysstat`, a third-party mod not in this repo) is gone from the published layout, so it no longer leaves an empty strip; Watch out says how to add it back. Mods unchanged (all 1.0.0).

### 1.0.0 (2026-11-11)

- First versioned release. Mods at: pond-agents 1.0.0, pond-files 1.0.0, pond-tabs 1.0.0, git 1.0.0, skills 1.0.0, todos 1.0.0, servers 1.0.0, remote-checker 1.0.0.
- Agents list: figure sets per space (pond-agents) (2026-11-11).
- Git: Conflicts pane (2026-11-10). PR panel (remote-checker) on the tab bar (2026-11-09).
