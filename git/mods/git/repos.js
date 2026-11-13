// Repo buttons from a `.herdr/git.toml` in the pane's folder or any folder above it.
// Supports a small TOML subset: top-level `default = "name"` and `[[repo]]` tables with `name`/`path`.
import { readTextFile } from "herdr";

const FILE = ".herdr/git.toml";

export function parseRepos(text, base) {
  const cfg = { base, default: null, repos: [] };
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[repo]]") { cur = {}; cfg.repos.push(cur); continue; }
    const m = line.match(/^([A-Za-z_]+)\s*=\s*"([^"]*)"\s*(#.*)?$/);
    if (!m) throw new Error(`can't read line: ${line}`);
    if (cur) cur[m[1]] = m[2]; else cfg[m[1]] = m[2];
  }
  cfg.repos = cfg.repos.filter(r => r.path).map(r => ({
    color: r.color,
    name: r.name || r.path.split("/").pop(),
    cwd: r.path.startsWith("/") ? r.path.replace(/\/+$/, "") : r.path === "." ? base : `${base}/${r.path.replace(/^\.\//, "").replace(/\/+$/, "")}`,
  }));
  return cfg;
}

export async function findRepoConfig(cwd, on) {
  if (!cwd?.startsWith("/")) return null;
  for (let dir = cwd.replace(/\/+$/, ""); ; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    const file = `${dir || ""}/${FILE}`;
    const text = await readTextFile(file, { on }).catch(() => null);
    if (text != null) return { file, ...parseRepos(text, dir || "/") };
    if (!dir) return null;
  }
}
