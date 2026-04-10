import { sendText, createLarkClients } from "./src/lark.js";
import fs from "fs";

async function test() {
  const config = JSON.parse(fs.readFileSync(".data/channels.json", "utf8"));
  const { appId, appSecret, ownerChatId } = config.feishu;
  
  if (!appId || !appSecret) {
    throw new Error("JSON 里也没找着秘钥！");
  }

  const { client } = createLarkClients(appId, appSecret);
  const message = "老山爹好！我是富贵。\n\n这是我为您专门准备的“特大号”测试消息。\n\n您看现在的字迹是不是又黑又亮，比之前的标准字体要气派不少？这就是咱们刚刚练成的“全量加粗”神功！";
  await sendText(client, ownerChatId, message);
  console.log("消息已送达老山爹飞书！");
}
test().catch(err => {
  console.error(err);
  process.exit(1);
});
