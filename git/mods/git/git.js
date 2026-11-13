// Git reads (exec, bounded and lock-free) and writes (hc terminals: hooks and network
// can outlast exec's 30 s limit, and a terminal can be peeked at if git prompts).
import { exec, hc } from "herdr";
import { layoutGraph } from "./graph.js";

// Reads write nothing under .git, so the folder watch doesn't refresh itself in a loop.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "diff.autoRefreshIndex=false"];
const US = "\x1f";
const MARKER = "__herdr_git_output__";

export const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function git(ctx, args) {
  return exec("git", [...READ, ...args], { cwd: ctx.root, on: ctx.on });
}
async function out(ctx, args) {
  const r = await git(ctx, args).catch(() => null);
  return r?.code === 0 ? r.stdout : "";
}

export async function openRepo(cwd, on) {
  const r = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on }).catch(() => null);
  if (r?.code !== 0) return null;
  const [root, gitDir] = r.stdout.trim().split("\n");
  return { root, gitDir, on };
}

export async function defaultRef(ctx) {
  const sym = (await out(ctx, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])).trim();
  if (sym) return sym;
  for (const ref of ["origin/main", "origin/master", "main", "master"])
    if ((await git(ctx, ["rev-parse", "--verify", "-q", ref]).catch(() => null))?.code === 0) return ref;
  return null;
}

export async function loadStatus(ctx) {
  const text = await out(ctx, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  const recs = text.split("\0"), info = { head: null, oid: null, upstream: null, ahead: 0, behind: 0 }, files = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# branch.head ")) info.head = r.slice(14);
    else if (r.startsWith("# branch.oid ")) info.oid = r.slice(13);
    else if (r.startsWith("# branch.upstream ")) info.upstream = r.slice(18);
    else if (r.startsWith("# branch.ab ")) { const [a, b] = r.slice(12).split(" "); info.ahead = +a; info.behind = -b; }
    else if (r[0] === "1" || r[0] === "2" || r[0] === "u") {
      const parts = r.split(" "), xy = parts[1];
      const path = parts.slice(r[0] === "1" ? 8 : r[0] === "2" ? 9 : 10).join(" ");
      if (r[0] === "2") i++;
      files.push({ path, x: xy[0], y: xy[1], conflict: r[0] === "u" });
    } else if (r[0] === "?") files.push({ path: r.slice(2), x: "?", y: "?", untracked: true });
  }
  files.sort((a, b) => Number(b.conflict ?? 0) - Number(a.conflict ?? 0) || a.path.localeCompare(b.path));
  for (const f of files) { f.staged = !f.untracked && !f.conflict && f.x !== "."; f.unstaged = f.untracked || f.conflict || f.y !== "."; }
  return { info, files };
}

// Which multi-step operation is in progress, read from the git dir like git's own prompt does.
export async function loadOp(ctx) {
  const script = 'g="$1"; r() { if [ -f "$1" ]; then head -n1 "$1"; else echo; fi; };'
    + ' if [ -d "$g/rebase-merge" ]; then echo rebase; r "$g/rebase-merge/head-name"; r "$g/rebase-merge/onto"; r "$g/rebase-merge/msgnum"; r "$g/rebase-merge/end";'
    + ' elif [ -d "$g/rebase-apply" ]; then echo rebase; r "$g/rebase-apply/head-name"; r "$g/rebase-apply/onto"; r "$g/rebase-apply/next"; r "$g/rebase-apply/last";'
    + ' elif [ -f "$g/MERGE_HEAD" ]; then echo merge; echo; r "$g/MERGE_HEAD"; echo; echo;'
    + ' elif [ -f "$g/CHERRY_PICK_HEAD" ]; then echo cherry-pick; echo; r "$g/CHERRY_PICK_HEAD"; echo; echo;'
    + ' elif [ -f "$g/REVERT_HEAD" ]; then echo revert; echo; r "$g/REVERT_HEAD"; echo; echo; fi';
  const r = await exec("sh", ["-c", script, "op", ctx.gitDir], { on: ctx.on }).catch(() => null);
  const [kind, headName, other, step, total] = (r?.stdout ?? "").split("\n");
  if (!kind) return null;
  const name = async sha => sha ? (await out(ctx, ["for-each-ref", "--points-at", sha, "--count=1", "--format=%(refname:short)"])).trim() || sha.slice(0, 8) : null;
  const op = { kind, branch: headName?.replace(/^refs\/heads\//, "") || null, other: await name(other), step: +step || null, total: +total || null };
  if (kind === "rebase") {
    const stopped = (await out(ctx, ["log", "-1", "--format=%h %s", "REBASE_HEAD"])).trim();
    op.current = stopped || null;
  }
  if (kind === "merge") op.message = (await out(ctx, ["log", "-1", "--format=%s", "MERGE_HEAD"])).trim();
  return op;
}

export async function loadBranches(ctx, base) {
  const fmt = ["%(HEAD)", "%(refname:short)", "%(upstream:short)", "%(upstream:track)", "%(committerdate:relative)", "%(objectname:short)", "%(contents:subject)", "%(worktreepath)"].join("%1f");
  const [locals, remotes, merged] = await Promise.all([
    out(ctx, ["for-each-ref", "--sort=-committerdate", `--format=${fmt}`, "refs/heads"]),
    out(ctx, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(committerdate:relative)%1f%(objectname:short)%1f%(contents:subject)", "refs/remotes"]),
    base ? out(ctx, ["branch", "--format=%(refname:short)", "--merged", base]) : "",
  ]);
  const mergedSet = new Set(merged.split("\n").filter(Boolean));
  const baseSha = base ? (await out(ctx, ["rev-parse", base]).catch(() => "")).trim() : null;
  const local = locals.split("\n").filter(Boolean).map(l => {
    const [head, name, upstream, track, date, sha, subject, worktree] = l.split(US);
    const ahead = +(track.match(/ahead (\d+)/)?.[1] ?? 0), behind = +(track.match(/behind (\d+)/)?.[1] ?? 0);
    return { kind: "local", name, head: head === "*", upstream: upstream || null, gone: track.includes("gone"), ahead, behind, date, sha, subject, worktree: head !== "*" && worktree ? worktree : null,
      // --merged also lists branches with no commits of their own (just made, work still uncommitted):
      // not "merged" when it sits exactly on the base or is checked out in another worktree.
      merged: mergedSet.has(name) && !baseSha?.startsWith(sha) && !(head !== "*" && worktree) };
  });
  const tracked = new Map(local.filter(b => b.upstream).map(b => [b.upstream, b.name]));
  const remote = remotes.split("\n").filter(Boolean).map(l => {
    const [name, date, sha, subject] = l.split(US);
    return { kind: "remote", name, short: name.replace(/^[^/]+\//, ""), remote: name.split("/")[0], date, sha, subject, local: tracked.get(name) ?? null };
  }).filter(b => b.name.includes("/") && !b.name.endsWith("/HEAD"));
  return { local, remote };
}

// Newest first, each with its graph lane (see graph.js) and pushed/merged state.
export async function loadCommits(ctx, target, base, limit = 400) {
  const fmt = ["%H", "%h", "%an", "%ar", "%D", "%s", "%P"].join("%x1f");
  const [log, unpushed, outside] = await Promise.all([
    out(ctx, ["log", "--topo-order", `--format=${fmt}`, "-n", String(limit), ...target]),
    out(ctx, ["log", "--format=%H", "-n", String(limit), ...target, "--not", "--remotes"]),
    base ? out(ctx, ["log", "--format=%H", "-n", String(limit), ...target, "--not", base]) : "",
  ]);
  const unpushedSet = new Set(unpushed.split("\n")), outsideSet = new Set(outside.split("\n"));
  return layoutGraph(log.split("\n").filter(Boolean).map(line => {
    const [sha, short, author, date, refs, subject, parents] = line.split(US);
    const state = unpushedSet.has(sha) ? "unpushed" : base && outsideSet.has(sha) ? "pushed" : "merged";
    return { sha, short, author, date, refs: refs ? refs.split(", ") : [], subject, parents: parents ? parents.split(" ") : [], state };
  }));
}

export async function loadStash(ctx) {
  const text = await out(ctx, ["stash", "list", "--format=%gd%x1f%cr%x1f%gs"]);
  return text.split("\n").filter(Boolean).map(l => { const [ref, date, message] = l.split(US); return { ref, date, message }; });
}

export async function loadPRs(ctx) {
  const r = await exec("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", "number,headRefName,state,isDraft,url,title,author,updatedAt,reviewDecision"], { cwd: ctx.root, on: ctx.on }).catch(() => null);
  if (r?.code !== 0) return null;
  let list;
  try { list = JSON.parse(r.stdout); } catch { return null; }
  const byBranch = {};
  for (const pr of list) if (!byBranch[pr.headRefName]) byBranch[pr.headRefName] = pr;
  const order = { OPEN: 0, MERGED: 1, CLOSED: 2 };
  list = list.map(pr => ({ ...pr, kind: "pr" }))
    .sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { byBranch, list };
}

// A PR as `gh pr view` prints it, then its diff (the main view splits them at "diff --git").
export async function prShow(ctx, number) {
  const run = args => exec("gh", args, { cwd: ctx.root, on: ctx.on }).then(r => r.code === 0 ? r.stdout : r.stderr || "").catch(e => String(e));
  const [view, diff] = await Promise.all([run(["pr", "view", String(number)]), run(["pr", "diff", String(number)])]);
  return clip(`${view.replace(/\n$/, "")}\n${diff}`);
}

const clip = text => { const lines = text.replace(/\n$/, "").split("\n"); return lines.length > 4000 ? [...lines.slice(0, 4000), "… (truncated)"] : lines; };

export const commitShow = async (ctx, sha) => clip(await out(ctx, ["show", "--stat", "--patch", "--format=fuller", "--no-color", sha]));
// A branch against the base, as a PR shows it: its own commits (newest first) and the diff from the merge base.
export async function branchLog(ctx, branch, base) {
  const raw = await out(ctx, ["log", "--format=%h%x1f%an%x1f%ar%x1f%s%x1f%b%x1e", "-n", "200", branch, ...(base ? ["--not", base] : [])]);
  return raw.split("\x1e").map(r => r.replace(/^\n/, "")).filter(Boolean).map(r => {
    const [short, author, date, subject, body] = r.split(US);
    return { short, author, date, subject, body: (body ?? "").replace(/\s+$/, "") };
  });
}
export const branchDiff = async (ctx, branch, base) => base ? clip(await out(ctx, ["diff", "--no-color", `${base}...${branch}`])).filter(Boolean) : [];
export const stashShow = async (ctx, ref) => clip(await out(ctx, ["stash", "show", "--stat", "--patch", "--include-untracked", "--no-color", ref]));

// Runs a shell script in a background core terminal through the login shell (so hooks
// find node/pnpm), then returns its exit code and the output after the marker
// (the marker drops whatever the shell's startup files print).
export async function runScript(ctx, script, shell, onStart) {
  const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--outlive-parent", "--cwd", ctx.root, "--label", "herdr.git=run"];
  if (ctx.on) args.push("--on", ctx.on);
  args.push("--", shell, "-lic", `printf '%s\\n' ${MARKER}; export GIT_EDITOR=true; ${script}`);
  const started = await hc(args).catch(e => ({ code: -1, stderr: String(e) }));
  if (started.code !== 0) return { code: -1, output: (started.stderr || started.stdout || "could not start").trim() };
  const addr = JSON.parse(started.stdout).address;
  onStart?.(addr);
  let code = null;
  for (let i = 0; i < 2000 && code === null; i++) {
    const w = await hc(["wait", addr, "--timeout", "15", "--json"]).catch(() => null);
    try { const j = JSON.parse(w?.stdout ?? "{}"); if (j.ended) code = j.exit_code ?? (j.signal ? 128 + j.signal : 1); } catch {}
    if (code === null) {
      const g = await hc(["get", addr, "--json"]).catch(() => null);
      try { const j = JSON.parse(g?.stdout ?? "{}"); if (j.state && j.state !== "live") code = j.exit_code ?? 1; } catch { code = 1; }
    }
  }
  const read = await hc(["read", addr, "--lines", "20000"]).catch(() => ({ stdout: "" }));
  let output = read.stdout ?? "";
  const at = output.indexOf(MARKER);
  if (at >= 0) output = output.slice(at + MARKER.length);
  await hc(["rm", addr]).catch(() => null);
  return { code, output: output.replace(/^\s*\n/, "").replace(/\s+$/, "") };
}
