import { join } from "node:path";
import { createAgent } from "./agent.ts";
import { interpretWithModel } from "./model.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

const tasks = createJsonTaskStore(join("data", "tasks.json"));
const reply = createAgent(tasks, process.env.DEEPSEEK_API_KEY ? interpretWithModel : undefined);
const app = createApp({ reply, tasks });
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
