import { sendText, createLarkClients } from "./src/lark.js";
import fs from "fs";

async function test() {
  const config = JSON.parse(fs.readFileSync(".data/channels.json", "utf8"));
  const { appId, appSecret } = config.feishu;
  const targetChatId = "oc_dfeb1da86cfd20db0c89c074c7c9371a";
  
  const { client } = createLarkClients(appId, appSecret);
  const message = "老山爹！富贵来啦！\n\n代码逻辑已经修好了，现在群聊应该没问题了。";
  await sendText(client, targetChatId, message);
  console.log("消息已发送到群聊：" + targetChatId);
}
test().catch(err => {
  console.error(err);
  process.exit(1);
});
