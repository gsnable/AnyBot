import { createLarkClients } from "./src/lark.js";
import fs from "fs";
import path from "path";
import { createReadStream } from "node:fs";

async function sendFileToTarget(client: any, receiveId: string, receiveIdType: "chat_id" | "open_id", filePath: string) {
  const upload = await client.im.file.create({
    data: {
      file_type: "pdf",
      file_name: path.basename(filePath),
      file: createReadStream(filePath),
    },
  });

  const fileKey = upload?.file_key;
  if (!fileKey) {
    throw new Error(`上传文件失败：${filePath}`);
  }

  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
  console.log(`成功发送文件至 ${receiveIdType}: ${receiveId}`);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(".data/channels.json", "utf8"));
  const { appId, appSecret, ownerChatId } = config.feishu;
  const ownerOpenId = "ou_b1b2dd58c6446dd804ea1780ccb7ffa1";

  const { client } = createLarkClients(appId, appSecret);
  const pdfPath = "/root/AnyBot-Dev/第四课 看拼音写词语.pdf";

  console.log(`准备将全量 25 词紧凑版 A4 PDF [${pdfPath}] 发送到飞书...`);
  
  if (ownerOpenId) {
    try {
      await sendFileToTarget(client, ownerOpenId, "open_id", pdfPath);
    } catch (e) {
      console.error("发送 open_id 失败:", e);
    }
  }

  if (ownerChatId) {
    try {
      await sendFileToTarget(client, ownerChatId, "chat_id", pdfPath);
    } catch (e) {
      console.error("发送 chat_id 失败:", e);
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("全流程发送失败:", err);
    process.exit(1);
  });
