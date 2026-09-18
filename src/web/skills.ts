import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { getProvider } from "../providers/index.js";
import { getDataDir } from "../shared.js";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  fullPath: string;
  source: string;
  enabled: boolean;
  content: string;
}

interface SkillSource {
  label: string;
  dir: string;
}

const PROVIDER_SKILL_DIRS: Record<string, () => SkillSource[]> = {
  codex: () => {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    return [{ label: "Codex 技能", dir: path.join(codexHome, "skills") }];
  },
  "claude-code": () => {
    return [{ label: "Claude Code 规则", dir: path.join(os.homedir(), ".claude") }];
  },
  "gemini-cli": () => {
    return [{ label: "Gemini CLI 技能", dir: path.join(os.homedir(), ".agents", "skills") }];
  },
  "cursor-cli": () => {
    const home = os.homedir();
    return [
      { label: "Cursor 技能", dir: path.join(home, ".cursor", "skills") },
      { label: "Cursor 规则技能", dir: path.join(home, ".cursor", "skills-cursor") },
      { label: "Agents 技能", dir: path.join(home, ".agents", "skills") },
    ];
  },
  "qoder-cli": () => {
    return [{ label: "Qoder CLI Agents", dir: path.join(os.homedir(), ".agents", "skills") }];
  },
};

function getSkillSources(): SkillSource[] {
  const providerType = getProvider().type;
  const factory = PROVIDER_SKILL_DIRS[providerType] ?? PROVIDER_SKILL_DIRS.codex!;
  const sources = factory();

  return sources.filter((s) => {
    try {
      return fs.statSync(s.dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function getDisabledSkillsPath(): string {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "disabled-skills.json");
}

function readDisabledSkills(): Set<string> {
  try {
    const raw = fs.readFileSync(getDisabledSkillsPath(), "utf-8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeDisabledSkills(disabled: Set<string>): void {
  fs.writeFileSync(getDisabledSkillsPath(), JSON.stringify([...disabled], null, 2), "utf-8");
}

function parseSkillMd(content: string): { name: string; description: string } {
  const result = { name: "", description: "" };
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;

  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);

  if (nameMatch) result.name = nameMatch[1].trim();
  if (descMatch) result.description = descMatch[1].trim();

  return result;
}

function scanSkillDir(dir: string): Array<{ name: string; skillPath: string }> {
  const results: Array<{ name: string; skillPath: string }> = [];

  function scan(currentDir: string): void {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(currentDir, entry.name);
        const skillMd = path.join(subDir, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          results.push({ name: entry.name, skillPath: skillMd });
        } else if (entry.name.startsWith(".")) {
          scan(subDir);
        }
      }
    } catch {
      // dir not readable
    }
  }

  scan(dir);
  return results;
}

export function listSkills(): { skills: SkillInfo[]; sources: Array<{ label: string; dir: string; count: number }> } {
  const disabled = readDisabledSkills();
  const sources = getSkillSources();
  const skills: SkillInfo[] = [];
  const sourceStats: Array<{ label: string; dir: string; count: number }> = [];

  for (const source of sources) {
    const found = scanSkillDir(source.dir);
    sourceStats.push({ label: source.label, dir: source.dir, count: found.length });

    for (const item of found) {
      const content = fs.readFileSync(item.skillPath, "utf-8");
      const meta = parseSkillMd(content);
      const id = `${source.label}::${item.name}`;

      skills.push({
        id,
        name: meta.name || item.name,
        description: meta.description || "",
        fullPath: item.skillPath,
        source: source.label,
        enabled: !disabled.has(id),
        content,
      });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, sources: sourceStats };
}

export function toggleSkill(id: string, enabled: boolean): void {
  const disabled = readDisabledSkills();
  if (enabled) {
    disabled.delete(id);
  } else {
    disabled.add(id);
  }
  writeDisabledSkills(disabled);
}

export function deleteSkill(id: string): { ok: boolean; error?: string } {
  const { skills } = listSkills();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return { ok: false, error: "技能不存在" };

  const skillDir = path.dirname(skill.fullPath);
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    const disabled = readDisabledSkills();
    disabled.delete(id);
    writeDisabledSkills(disabled);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "删除失败" };
  }
}

function openDirectory(dir: string): void {
  try {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return;
    }
    const platform = os.platform();
    if (platform === "darwin") {
      spawn("open", [resolved], { stdio: "ignore", detached: true });
    } else if (platform === "win32") {
      spawn("explorer", [resolved], { stdio: "ignore", detached: true });
    } else {
      // Linux: try xdg-open directly with arguments
      const child = spawn("xdg-open", [resolved], { stdio: "ignore", detached: true });
      child.on("error", () => {});
    }
  } catch {}
}

export function openSkillsFolder(skillPath?: string): void {
  const sources = getSkillSources();
  if (skillPath) {
    const resolved = path.resolve(skillPath);
    const targetDir = path.dirname(resolved);
    // 校验目标必须属于某个已注册的技能源目录，防止任意路径打开
    const isAllowed = sources.some(s => resolved.startsWith(path.resolve(s.dir)));
    if (isAllowed && fs.existsSync(targetDir)) {
      openDirectory(targetDir);
    }
    return;
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const defaultDir = path.join(codexHome, "skills");
  const baseDir = sources[0]?.dir || defaultDir;
  const dirs = new Set<string>();

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(baseDir, entry.name);
      if (entry.name.startsWith(".")) {
        try {
          const inner = fs.readdirSync(sub, { withFileTypes: true });
          if (inner.some((e) => e.isDirectory() && fs.existsSync(path.join(sub, e.name, "SKILL.md")))) {
            dirs.add(sub);
          }
        } catch {}
      } else if (fs.existsSync(path.join(sub, "SKILL.md"))) {
        dirs.add(baseDir);
      }
    }
  } catch {}

  if (dirs.size === 0) dirs.add(baseDir);

  for (const d of dirs) {
    openDirectory(d);
  }
}
