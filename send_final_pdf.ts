import { sendFile, sendText, createLarkClients } from "./src/lark.js";
import fs from "fs";
import path from "path";

async function main() {
  const config = JSON.parse(fs.readFileSync(".data/channels.json", "utf8"));
  const { appId, appSecret, ownerChatId } = config.feishu;
  const targetChatId = "oc_6e3f8224dbf81d37ac584b015b5ee5e2";

  const { client } = createLarkClients(appId, appSecret);
  const pdfPath = "/root/AnyBot-Dev/第四课 看拼音写词语.pdf";

  console.log(`准备将全新矢量的 A4 PDF [${pdfPath}] 发送到飞书...`);
  
  await sendText(client, targetChatId, "老山爹，富贵已全面改用 ReportLab 矢量引擎重构了字帖生成器，排除了无头浏览器渲染不全和边距截断的问题。这是为您重新生成的标准 A4《第四课 看拼音写词语.pdf》，包含全部 20 个词语，排版精致美观，请您查收！");
  await sendFile(client, targetChatId, pdfPath);
  
  console.log("PDF 发送成功！");
}

main().catch(err => {
  console.error("发送失败:", err);
  process.exit(1);
});
