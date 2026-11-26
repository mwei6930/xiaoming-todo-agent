import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretWithModel } from "./model.ts";

test("DeepSeek 客户端发送实际的 JSON 请求，能解析返回值并识别空响应", async (t) => {
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "local-test";
  t.after(() => {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  });
  const task = { id: "id-a", title: "洗衣服", done: false };
  const messages = [{ role: "user" as const, content: "衣服都已经晾起来啦" }];
  let content = '{"action":"complete","ids":["id-a"]}';
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.deepseek.com/chat/completions");
    const body = await request.json();
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(JSON.parse(body.messages[1].content), {
      today: "2028-02-28",
      tasks: [task],
      conversation: messages,
    });
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  });
  assert.deepEqual(await interpretWithModel(messages, [task], "2028-02-28"), {
    action: "complete",
    ids: [task.id],
  });
  content = "  ";
  await assert.rejects(interpretWithModel(messages, [task], "2028-02-28"), SyntaxError);
});
