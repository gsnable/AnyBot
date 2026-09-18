import { spawn, execSync } from "node:child_process";
import path from "node:path";
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
import { v4 as uuidv4 } from "uuid";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.PROVIDER_TIMEOUT_MS || "600000", 10);

interface ClaudeJsonOutput {
  id?: string;
  response?: string;
  result?: string;
  error?: {
    message?: string;
  };
}

export class ClaudeCliProvider implements IProvider {
  readonly type = "claude-code";
  readonly displayName = "Claude Code";
  readonly capabilities: ProviderCapabilities = {
    sessionResume: true,
    imageInput: true, 
    sandbox: false,
  };

  private readonly bin: string;
  private activeProcesses = new Map<string, number>();

  constructor(opts?: { bin?: string }) {
    this.bin = opts?.bin ?? "claude";
  }

  async stop(chatId: string): Promise<void> {
    const pgid = this.activeProcesses.get(chatId);
    if (pgid) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (e) {
        // ignore
      } finally {
        this.activeProcesses.delete(chatId);
      }
    }
  }

  listModels(): ProviderModel[] {
    return [
      { id: "sonnet", name: "Claude 3.7 Sonnet (Latest)", description: "当前最强 Sonnet 模型" },
      { id: "opus", name: "Claude 3 Opus (Latest)", description: "最强推理模型" },
      { id: "haiku", name: "Claude 3.5 Haiku (Latest)", description: "极速响应模型" },
    ];
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
    const effectiveSessionId = sessionId || uuidv4();

    const effectiveWorkdir = workdir || process.cwd();

    // 终极提示词优化：最朴素的中文指令对当前环境最有效
    let finalPrompt = prompt;
    if (imagePaths.length > 0) {
      const relPaths = imagePaths.map(p => path.relative(effectiveWorkdir, p)).join("、");
      finalPrompt = `请读取并分析图片 [${relPaths}] 的内容。用户的问题是：${prompt}`;
    }

    const args: string[] = [
      "-p", finalPrompt,
      "--output-format", "json",
      "--settings", "{}", 
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", effectiveSessionId);
    }

    if (model) {
      args.push("--model", model);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: effectiveWorkdir,
        env: { ...process.env, CLAUDE_CODE_SIMPLE: "1" },
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

      child.stdout.on("data", (chunk) => stdout += chunk.toString("utf8"));
      child.stderr.on("data", (chunk) => stderr += chunk.toString("utf8"));
      child.stdin.end();

      child.on("error", (error) => {
        clearTimeout(timer);
        if (chatId) this.activeProcesses.delete(chatId);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (chatId) this.activeProcesses.delete(chatId);

        if (killed) {
          reject(new ProviderTimeoutError(timeoutMs));
          return;
        }

        if (code !== 0 && stderr.includes("No conversation found")) {
          const retryArgs = args.filter(a => a !== "--resume" && a !== sessionId);
          retryArgs.push("--session-id", effectiveSessionId);
          const retryChild = spawn(this.bin, retryArgs, {
            cwd: effectiveWorkdir,
            env: { ...process.env, CLAUDE_CODE_SIMPLE: "1" },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          });
          let rStdout = "";
          retryChild.stdout.on("data", (c) => rStdout += c.toString("utf8"));
          retryChild.stdin.end();
          retryChild.on("close", (rCode) => {
            if (rCode !== 0) reject(new ProviderProcessError(rCode, "Retry failed"));
            else this.processResult(rStdout, effectiveSessionId, resolve, reject, startedAt, effectiveWorkdir);
          });
          return;
        }

        if (code !== 0) {
          reject(new ProviderProcessError(code, stderr || stdout));
          return;
        }

        this.processResult(stdout, effectiveSessionId, resolve, reject, startedAt, effectiveWorkdir);
      });
    });
  }

  private processResult(stdout: string, sessionId: string, resolve: any, reject: any, startedAt: number, workdir: string) {
    let parsed: ClaudeJsonOutput;
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : stdout.trim();
      parsed = JSON.parse(jsonStr) as ClaudeJsonOutput;
    } catch {
      reject(new ProviderParseError(stdout));
      return;
    }

    const responseText = (parsed.result || parsed.response)?.trim();
    if (!responseText) {
      reject(new ProviderEmptyOutputError());
      return;
    }

    resolve({ text: responseText, sessionId: sessionId });
  }
}
