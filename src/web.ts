import "dotenv/config";
import { createApp } from "./web/server.js";

const PORT = parseInt(process.env.WEB_PORT || "19981", 10);

const app = createApp();

app.listen(PORT, () => {
  console.log(`\n  Codex Web UI 已启动\n`);
  console.log(`  ➜  本地访问: http://localhost:${PORT}`);
  console.log(`  ➜  网络访问: http://0.0.0.0:${PORT}\n`);
});
