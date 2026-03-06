import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { logger } from "./logger.js";

/**
 * Skill 元信息
 */
export type SkillMeta = {
  /** skill 名称（来自 frontmatter 或目录名） */
  name: string;
  /** skill 描述（来自 frontmatter） */
  description: string;
  /** SKILL.md 文件的绝对路径 */
  filePath: string;
};

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 name 和 description。
 * frontmatter 格式示例：
 * ---
 * name: my-skill
 * description: 这是一个示例 skill
 * ---
 */
function parseFrontmatter(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { name: fallbackName, description: "" };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { name: fallbackName, description: "" };
  }

  const frontmatterBlock = trimmed.slice(3, endIndex).trim();
  let name = fallbackName;
  let description = "";

  for (const line of frontmatterBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line
      .slice(colonIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    if (key === "name" && value) {
      name = value;
    } else if (key === "description" && value) {
      description = value;
    }
  }

  return { name, description };
}

/**
 * 扫描指定目录下的所有 skill（包含 SKILL.md 的子目录）。
 * 支持嵌套目录结构。
 */
export function scanSkills(skillsDir: string): SkillMeta[] {
  if (!skillsDir?.trim()) {
    return [];
  }

  const resolved = path.resolve(skillsDir);
  if (!existsSync(resolved)) {
    logger.warn("skills.dir_not_found", { skillsDir: resolved });
    return [];
  }

  const skills: SkillMeta[] = [];

  try {
    const entries = readdirSync(resolved);

    for (const entry of entries) {
      const entryPath = path.join(resolved, entry);

      // 跳过非目录
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }

      const skillMdPath = path.join(entryPath, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        continue;
      }

      try {
        const content = readFileSync(skillMdPath, "utf8");
        const { name, description } = parseFrontmatter(content, entry);

        skills.push({
          name,
          description,
          filePath: skillMdPath,
        });

        logger.debug("skills.loaded", {
          name,
          description: description || null,
          filePath: skillMdPath,
        });
      } catch (readError) {
        logger.warn("skills.read_error", {
          skillDir: entryPath,
          error: readError,
        });
      }
    }
  } catch (scanError) {
    logger.error("skills.scan_error", {
      skillsDir: resolved,
      error: scanError,
    });
  }

  logger.info("skills.scan_complete", {
    skillsDir: resolved,
    skillCount: skills.length,
    skillNames: skills.map((s) => s.name),
  });

  return skills;
}

/**
 * 构建 skills 提示词段落，注入到系统提示词中。
 * 仅包含 skill 的名称、描述和文件路径，不加载完整内容（由 Codex 按需读取）。
 */
export function buildSkillsPromptSection(skillsDir: string): string | null {
  const skills = scanSkills(skillsDir);
  if (skills.length === 0) {
    return null;
  }

  const skillEntries = skills
    .map((skill) => {
      const desc = skill.description
        ? `: ${skill.description}`
        : "";
      return `- **${skill.name}**${desc}\n  文件路径: \`${skill.filePath}\``;
    })
    .join("\n");

  return [
    "# Skills",
    "",
    "你可以使用以下 skills 来完成特定任务。每个 skill 包含专门的指令和工具。",
    "当任务与某个 skill 相关时，请先读取对应的 SKILL.md 文件获取完整指令，然后严格按照指令执行。",
    "",
    "## 可用 Skills",
    "",
    skillEntries,
  ].join("\n");
}
