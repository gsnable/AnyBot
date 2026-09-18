import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
} from "./types.js";
import {
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
  ProviderParseError,
} from "./codex.js";
import { logger } from "../logger.js";

// ------------------------------------------------------------------
// Model Resolver Cache
// ------------------------------------------------------------------
let cachedModels: { [key: string]: string } = {};
let cachedModelsExpiry = 0;

function resolveAgyModel(bin: string, userModel: string): string | undefined {
  const lower = userModel.toLowerCase();
  
  if (lower.startsWith("gemini-") || lower.startsWith("claude-") || lower.startsWith("gpt-") || 
      lower.includes("(") || lower.includes(")")) {
    return userModel;
  }

  const now = Date.now();
  if (now > cachedModelsExpiry) {
    try {
      const out = execSync(`${bin} models`, { encoding: "utf8", stdio: "pipe", timeout: 10_000 });
      const lines = out.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("Fetching") && !l.startsWith("⠋") && !l.startsWith("⠙"));
      const newCache: { [key: string]: string } = {};
      for (const line of lines) {
        const id = line.split(/\s+/)[0];
        if (id) {
          if (!newCache["flash"] && id.includes("flash")) newCache["flash"] = id;
          if (!newCache["pro"] && id.includes("pro")) newCache["pro"] = id;
          if (!newCache["sonnet"] && id.includes("sonnet")) newCache["sonnet"] = id;
          if (!newCache["opus"] && id.includes("opus")) newCache["opus"] = id;
        }
      }
      cachedModels = newCache;
      cachedModelsExpiry = now + 12 * 60 * 60 * 1000;
    } catch (e) {
      logger.warn("Failed to fetch models from agy, falling back to defaults", { error: String(e) });
      cachedModels = {
        "pro": "Gemini 3.1 Pro (Low)",
        "flash": "Gemini 3.5 Flash (Medium)",
        "sonnet": "Claude Sonnet 4.6 (Thinking)",
        "opus": "Claude Opus 4.6 (Thinking)",
      };
      cachedModelsExpiry = now + 60 * 1000;
    }
  }

  if (lower.includes("pro")) return cachedModels["pro"];
  if (lower.includes("flash")) return cachedModels["flash"];
  if (lower.includes("sonnet")) return cachedModels["sonnet"];
  if (lower.includes("opus")) return cachedModels["opus"];
  
  return undefined;
}

const DEFAULT_TIMEOUT_MS = parseInt(process.env.PROVIDER_TIMEOUT_MS || "600000", 10);

interface GeminiJsonOutput {
  session_id?: string;
  response?: string;
  stats?: unknown;
  error?: {
    type?: string;
    message?: string;
    code?: number;
  };
}

export class ProviderSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "ProviderSessionNotFoundError";
  }
}

export class GeminiCliProvider implements IProvider {
  readonly type = "gemini-cli";
  readonly displayName = "Gemini CLI";
  readonly capabilities: ProviderCapabilities = {
    sessionResume: true,
    imageInput: true,
    sandbox: false,
  };

  private readonly bin: string;
  private readonly approvalMode: string;
  private activeProcesses = new Map<string, number>();

  constructor(opts?: { bin?: string; approvalMode?: string }) {
    this.bin = opts?.bin ?? "gemini";
    this.approvalMode = opts?.approvalMode ?? "yolo";
  }

  async stop(chatId: string): Promise<void> {
    const pgid = this.activeProcesses.get(chatId);
    if (pgid) {
      try {
        process.kill(-pgid, "SIGKILL");
        logger.info("provider.exec.stopped", { provider: this.type, chatId, pgid });
      } catch (e) {
        logger.warn("provider.exec.stop_failed", { provider: this.type, chatId, pgid, error: e });
      } finally {
        this.activeProcesses.delete(chatId);
      }
    }
  }

  listModels(): ProviderModel[] {
    return [
      { id: "auto", name: "Auto", description: "自动选择最佳模型" },
      { id: "pro", name: "Gemini Pro", description: "复杂推理任务" },
      { id: "flash", name: "Gemini Flash", description: "快速均衡模型" },
      { id: "flash-lite", name: "Gemini Flash Lite", description: "最快轻量模型" },
    ];
  }

  private getDbModTimes(convDir: string): Map<string, number> {
    const map = new Map<string, number>();
    try {
      if (fs.existsSync(convDir)) {
        const files = fs.readdirSync(convDir);
        for (const file of files) {
          if (file.endsWith(".db")) {
            const filePath = path.join(convDir, file);
            const stat = fs.statSync(filePath);
            map.set(file, stat.mtimeMs);
          }
        }
      }
    } catch (e) {
      logger.warn("provider.resolve_session.scan_failed", { dir: convDir, error: e });
    }
    return map;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const {
      workdir,
      prompt,
      model,
      sessionId,
      chatId,
      imagePaths = [],
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = opts;
    const startedAt = Date.now();

    const isAgy = this.bin.includes("agy") || this.bin === "antigravity-cli";
    const effectiveSessionId = isAgy ? (sessionId || randomUUID()) : sessionId;

    // Resolve agy conversations directory and scan mod times before execution
    const geminiDir = process.env.GEMINI_DIR 
      ? (path.isAbsolute(process.env.GEMINI_DIR) ? process.env.GEMINI_DIR : path.join(os.homedir(), ".gemini"))
      : path.join(os.homedir(), ".gemini");
    const convDir = path.join(geminiDir, "antigravity-cli", "conversations");
    const preDbTimes = isAgy ? this.getDbModTimes(convDir) : new Map<string, number>();

    // 将图片路径转换为 @ 语法并追加到 Prompt
    let finalPrompt = prompt;
    if (imagePaths.length > 0) {
      const imageAttachments = imagePaths.map(p => `@'${p}'`).join(" ");
      finalPrompt = `${prompt} ${imageAttachments}`;
    }

    let args: string[];
    if (isAgy) {
      args = [
        "-p", finalPrompt,
        "--dangerously-skip-permissions",
        "--conversation", effectiveSessionId!,
      ];
      let agyModel = model;
      if (agyModel && agyModel !== "auto") {
        agyModel = resolveAgyModel(this.bin, agyModel);
      } else {
        agyModel = undefined;
      }
      if (agyModel) {
        args.push("--model", agyModel);
      }
    } else {
      args = [
        "-p", finalPrompt,
        "--output-format", "json",
        "--approval-mode", this.approvalMode,
      ];
      if (model) {
        args.push("-m", model);
      }
      if (sessionId) {
        args.push("-r", sessionId);
      }
    }

    logger.info("provider.exec.start", {
      provider: this.type,
      bin: this.bin,
      workdir,
      model: model || null,
      sessionId: sessionId || null,
      promptChars: prompt.length,
      timeoutMs,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: workdir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      if (child.pid && chatId) {
        this.activeProcesses.set(chatId, child.pid);
      }

      let stdout = "";
      let stderr = "";
      let killed = false;

      const killProcessGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          try {
            execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
          } catch {
            child.kill(signal);
          }
        } else {
          try {
            process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        }
      };

      const timer = setTimeout(() => {
        killed = true;
        killProcessGroup("SIGTERM");
        setTimeout(() => {
          if (!child.killed) killProcessGroup("SIGKILL");
        }, 3000);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.stdin.end();

      child.on("error", (error) => {
        clearTimeout(timer);
        if (chatId) this.activeProcesses.delete(chatId);
        logger.error("provider.exec.spawn_error", {
          provider: this.type,
          workdir,
          durationMs: Date.now() - startedAt,
          error,
        });
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (chatId) this.activeProcesses.delete(chatId);

        if (killed) {
          logger.warn("provider.exec.timeout", {
            provider: this.type,
            workdir,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
          });
          reject(new ProviderTimeoutError(timeoutMs));
          return;
        }

        if (isAgy) {
          if (code !== 0) {
            logger.error("provider.exec.non_zero_exit", {
              provider: this.type,
              code,
              workdir,
              durationMs: Date.now() - startedAt,
              stdoutChars: stdout.length,
              stderrChars: stderr.length,
              stderrPreview: stderr.slice(0, 400),
            });
            reject(new ProviderProcessError(code, stderr || stdout));
            return;
          }

          // 过滤掉 Warning: conversation "..." not found.
          let responseText = stdout;
          responseText = responseText.replace(/Warning: conversation ".*?" not found\.\r?\n?/gi, "").trim();

          // 1. 剔除末尾的工作总结
          const summaryIndex = responseText.indexOf("***\n\n**工作总结：**");
          if (summaryIndex !== -1) {
            responseText = responseText.substring(0, summaryIndex);
          } else {
            const altSummaryIndex = responseText.indexOf("***\r\n\r\n**工作总结：**");
            if (altSummaryIndex !== -1) {
              responseText = responseText.substring(0, altSummaryIndex);
            }
          }

          // 2. 剔除开头的思考轨迹 (从第一个中文字符向上寻找行首截取)
          const firstChineseMatch = responseText.match(/[\u4e00-\u9fa5]/);
          if (firstChineseMatch && firstChineseMatch.index !== undefined) {
            let startPos = firstChineseMatch.index;
            while (startPos > 0 && responseText[startPos - 1] !== "\n") {
              startPos--;
            }
            responseText = responseText.substring(startPos);
          }

          responseText = responseText.trim();

          if (!responseText) {
            logger.error("provider.exec.empty_response", {
              provider: this.type,
              workdir,
              durationMs: Date.now() - startedAt,
              stdoutChars: stdout.length,
            });
            reject(new ProviderEmptyOutputError());
            return;
          }

          // Detect which database was updated or created during the execution
          let resolvedSessionId = effectiveSessionId!;
          const postDbTimes = this.getDbModTimes(convDir);
          let newestTime = 0;
          let newestFile: string | null = null;

          for (const [file, mtime] of postDbTimes.entries()) {
            const preTime = preDbTimes.get(file) || 0;
            if (mtime > preTime) {
              if (mtime > newestTime) {
                newestTime = mtime;
                newestFile = file;
              }
            }
          }

          if (newestFile) {
            resolvedSessionId = path.basename(newestFile, ".db");
            logger.info("provider.exec.resolved_session_id", {
              provider: this.type,
              previousId: effectiveSessionId,
              resolvedId: resolvedSessionId,
            });
          }

          logger.info("provider.exec.success", {
            provider: this.type,
            workdir,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            replyChars: responseText.length,
            sessionId: resolvedSessionId,
          });

          resolve({
            text: responseText,
            sessionId: resolvedSessionId,
          });
          return;
        }

        // 判定 Session 是否丢失：1. 退出码为 42；2. 或者虽然退出码正常但 stderr 明确报了恢复失败
        const isSessionLost = (code === 42 || code === 0) && 
                             sessionId && 
                             stderr.includes("Error resuming session");

        if (isSessionLost) {
          logger.warn("provider.exec.session_not_found_detected", {
            provider: this.type,
            code,
            sessionId,
            stderrPreview: stderr.slice(0, 200)
          });
          reject(new ProviderSessionNotFoundError(sessionId));
          return;
        }

        if (code !== 0) {
          logger.error("provider.exec.non_zero_exit", {
            provider: this.type,
            code,
            workdir,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            stderrPreview: stderr.slice(0, 400),
            stdoutPreview: stdout.slice(0, 400),
          });
          reject(new ProviderProcessError(code, stderr || stdout));
          return;
        }

        let parsed: GeminiJsonOutput;
        try {
          // 容错处理：Gemini CLI 可能会在正式 JSON 前输出非 JSON 的日志/警告信息
          // 我们使用正则表达式抓取第一个 { 和最后一个 } 之间的内容
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          const jsonStr = jsonMatch ? jsonMatch[0] : stdout.trim();
          parsed = JSON.parse(jsonStr) as GeminiJsonOutput;
        } catch {
          logger.error("provider.exec.parse_error", {
            provider: this.type,
            workdir,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stdoutPreview: stdout.slice(0, 400),
          });
          reject(new ProviderParseError(stdout));
          return;
        }

        if (parsed.error) {
          const errMsg = `${parsed.error.type || "Error"}: ${parsed.error.message || "unknown"}`;
          logger.error("provider.exec.api_error", {
            provider: this.type,
            workdir,
            durationMs: Date.now() - startedAt,
            errorType: parsed.error.type,
            errorMessage: parsed.error.message,
            errorCode: parsed.error.code,
          });
          reject(new ProviderProcessError(parsed.error.code ?? 1, errMsg));
          return;
        }

        const responseText = parsed.response?.trim();
        if (!responseText) {
          logger.error("provider.exec.empty_response", {
            provider: this.type,
            workdir,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
          });
          reject(new ProviderEmptyOutputError());
          return;
        }

        // 优先从大仙返回的 JSON 中提取会话 ID，大仙给的才是最准的！
        const newSessionId = parsed.session_id || sessionId || this.resolveLatestSessionId(workdir);

        logger.info("provider.exec.success", {
          provider: this.type,
          workdir,
          durationMs: Date.now() - startedAt,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          replyChars: responseText.length,
          sessionId: newSessionId,
        });

        resolve({
          text: responseText,
          sessionId: newSessionId,
        });
      });
    });
  }

  private resolveLatestSessionId(workdir: string): string | null {
    const isAgy = this.bin.includes("agy") || this.bin === "antigravity-cli";
    if (isAgy) {
      return null;
    }
    try {
      const output = execSync(`${this.bin} --list-sessions`, {
        cwd: workdir,
        timeout: 10_000,
        encoding: "utf8",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const lines = output.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^\s*1[.):\s]+.*?([0-9a-f]{8,}(?:-[0-9a-f]+)*)/i);
        if (match) return match[1];
      }

      const uuidMatch = lines[0]?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) return uuidMatch[1];

      return null;
    } catch {
      logger.warn("provider.session.list_failed", { provider: this.type });
      return null;
    }
  }
}
