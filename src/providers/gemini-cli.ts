import { spawn, execSync } from "node:child_process";
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

    // 将图片路径转换为 @ 语法并追加到 Prompt
    let finalPrompt = prompt;
    if (imagePaths.length > 0) {
      const imageAttachments = imagePaths.map(p => `@'${p}'`).join(" ");
      finalPrompt = `${prompt} ${imageAttachments}`;
    }

    const args: string[] = [
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

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.stdin.end();

      child.on("error", (error) => {
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
        if (chatId) this.activeProcesses.delete(chatId);

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
