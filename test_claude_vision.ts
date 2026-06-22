import { ClaudeCliProvider } from "./src/providers/claude-cli.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTest() {
  console.log("🚀 富贵内测开始：正在请 Claude 大仙看图...");
  
  const provider = new ClaudeCliProvider({ bin: "claude" });
  const testImagePath = path.resolve(__dirname, "assets/模型切换.png");
  
  try {
    const result = await provider.run({
      workdir: "/root/AnyBot-Dev",
      prompt: "老山爹让我考考你，这张图片里画的是什么？请简要描述。",
      model: "sonnet",
      chatId: "internal-test",
      imagePaths: [testImagePath]
    });
    
    console.log("\n✅ 测试成功！Claude 回复如下：");
    console.log("----------------------------------------");
    console.log(result.text);
    console.log("----------------------------------------");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ 测试失败：");
    console.error(error);
    process.exit(1);
  }
}

runTest();
