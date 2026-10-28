// 工作区路径重映射：换一台机器以后，storages/workspace.json 里的 D:\\Code\\xxx 之类绝对路径
// 可能根本不存在（盘符不同、用户目录不同）。这里在「从机拉取」完成后把它们改到本机能找到的位置，
// 改之前留一份 .bak-<时间戳>，改不动就只告警、绝不删除。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** 解析「原前缀=>新前缀」文本，支持 => 和 -> 两种写法，忽略空行与 # 注释。 */
export function parseMap(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.*?)\s*(?:=>|->)\s*(.*)$/);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    if (!from || !to) continue;
    out.push({ from, to });
  }
  return out;
}

/** 比较用的键：Windows 不区分大小写，统一小写 + 去掉尾部斜杠。 */
export function key(p) {
  const s = String(p || "").trim().replace(/[\\/]+$/, "");
  return IS_WIN ? s.toLowerCase() : s;
}

/** 本机存在的盘符（仅 Windows，如 ["C:","D:"]）。 */
export function drives() {
  if (!IS_WIN) return [];
  const out = [];
  for (let c = 67; c <= 90; c += 1) {
    const d = String.fromCharCode(c) + ":";
    try {
      if (fs.existsSync(d + "\\")) out.push(d);
    } catch {
      // 没权限/没盘符，跳过
    }
  }
  return out;
}

/** 把一个工作区路径重映射后的候选位置（按优先级）：先手动映射，再换盘符，再放到用户目录下。 */
export function candidatesFor(p, opts = {}) {
  const exists = opts.exists || ((x) => { try { return fs.existsSync(x); } catch { return false; } });
  const map = opts.map || [];
  const list = opts.drives || drives();
  const home = opts.home || os.homedir();
  const out = [];
  const add = (value, why) => {
    if (!value) return;
    if (out.some((item) => key(item.value) === key(value))) return;
    out.push({ value, why });
  };
  const trimmed = String(p).replace(/[\\/]+$/, "");
  for (const rule of map) {
    const from = String(rule.from).replace(/[\\/]+$/, "");
    if (!from) continue;
    if (key(trimmed).startsWith(key(from))) {
      const rest = trimmed.slice(from.length);
      const to = String(rule.to).replace(/[\\/]+$/, "");
      add(to + rest, "手动映射 " + rule.from + " => " + rule.to);
    }
  }
  const driveMatch = IS_WIN ? String(p).match(/^([A-Za-z]):(.*)$/) : null;
  if (driveMatch) {
    for (const d of list) {
      if (d.toUpperCase() !== driveMatch[1].toUpperCase()) add(d + driveMatch[2], "换盘符到 " + d);
    }
  }
  const base = path.basename(String(p).replace(/[\\/]+$/, ""));
  add(path.join(home, "Documents", base), "用户目录 Documents/" + base);
  add(path.join(home, base), "用户目录 " + base);
  return out.filter((item) => exists(item.value));
}

/** 读本机工作区列表（缺文件/坏 JSON 都当空）。 */
export function readWorkspaces(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const table = data && data.tables && data.tables.workspaces;
  if (!table || typeof table !== "object") return [];
  const out = [];
  for (const [id, value] of Object.entries(table)) {
    if (!value || typeof value !== "object") continue;
    out.push({ id, title: String(value.title || ""), path: String(value.path || "") });
  }
  return out;
}

/** 纯函数：算出每个工作区该怎么办（供自测，不写盘）。 */
export function planRemap(workspaces, opts = {}) {
  const exists = opts.exists || ((x) => { try { return fs.existsSync(x); } catch { return false; } });
  const changes = [];
  const skipped = [];
  const unresolved = [];
  for (const ws of workspaces) {
    if (!ws.path) {
      skipped.push({ ...ws, reason: "路径是空的" });
      continue;
    }
    if (exists(ws.path)) {
      skipped.push({ ...ws, reason: "本机已存在" });
      continue;
    }
    const hit = candidatesFor(ws.path, opts)[0];
    if (hit) changes.push({ ...ws, to: hit.value, why: hit.why });
    else unresolved.push({ ...ws, reason: "本机找不到替代位置" });
  }
  return { changes, skipped, unresolved };
}

/** 把计划落到 workspace.json：先备份，再写回；返回备份路径。 */
export function applyRemap(file, plan) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const table = data && data.tables && data.tables.workspaces;
  if (!table) throw new Error("workspace.json 里没有 tables.workspaces");
  for (const change of plan.changes) {
    const item = table[change.id];
    if (!item) continue;
    item.path = change.to;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const backup = file + ".bak-" + stamp;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { backup };
}

/** 一次完整重映射：读 -> 计划 -> 写（有变化才写）。返回报告，结果同时存一份到 <home>/workspace-remap.json。 */
export function remapWorkspaces(cfg) {
  const home = cfg && cfg.dshHome ? cfg.dshHome : path.join(os.homedir(), ".dsh");
  const file = path.join(home, "storages", "workspace.json");
  const reportFile = path.join(home, "workspace-remap.json");
  const report = { at: new Date().toISOString(), file, remapped: [], skipped: [], unresolved: [], backup: "", error: "" };
  if (!fs.existsSync(file)) {
    report.error = "本机没有 storages/workspace.json（好像没同步 storages，跳过）";
    return report;
  }
  try {
    const workspaces = readWorkspaces(file);
    const plan = planRemap(workspaces, { map: parseMap(cfg && cfg.workspaceMap) });
    report.remapped = plan.changes.map((c) => ({ id: c.id, title: c.title, from: c.path, to: c.to, why: c.why }));
    report.skipped = plan.skipped.map((s) => ({ id: s.id, title: s.title, path: s.path, reason: s.reason }));
    report.unresolved = plan.unresolved.map((u) => ({ id: u.id, title: u.title, path: u.path, reason: u.reason }));
    if (plan.changes.length) report.backup = applyRemap(file, plan).backup;
  } catch (error) {
    report.error = String((error && error.message) || error);
  }
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch {
    // 报告写不了不影响主流程
  }
  return report;
}

/** 读上一次的报告（给配置页显示）。 */
export function lastRemap(cfg) {
  const home = cfg && cfg.dshHome ? cfg.dshHome : path.join(os.homedir(), ".dsh");
  try {
    const text = fs.readFileSync(path.join(home, "workspace-remap.json"), "utf8");
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** 给配置页/插件卡用的一行摘要。 */
export function workspaceSummary(cfg) {
  const home = cfg && cfg.dshHome ? cfg.dshHome : path.join(os.homedir(), ".dsh");
  const file = path.join(home, "storages", "workspace.json");
  const workspaces = readWorkspaces(file);
  const missing = workspaces.filter((ws) => { try { return !fs.existsSync(ws.path); } catch { return true; } });
  const last = lastRemap(cfg);
  return {
    file,
    total: workspaces.length,
    missing: missing.map((ws) => ({ title: ws.title, path: ws.path })),
    remap: !(cfg && cfg.workspaceRemap === false),
    mapRules: parseMap(cfg && cfg.workspaceMap).length,
    last: last ? { at: last.at, remapped: (last.remapped || []).length, unresolved: (last.unresolved || []).length, backup: last.backup || "", error: last.error || "" } : null,
  };
}

export default { parseMap, planRemap, applyRemap, remapWorkspaces, workspaceSummary, lastRemap, candidatesFor, readWorkspaces, drives };
