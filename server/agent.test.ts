import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import type { Interpret } from "./model.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function setup(t: TestContext, interpret?: Interpret) {
  const dir = await mkdtemp(join(tmpdir(), "xiaoming-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.json");
  const store = createJsonTaskStore(file);
  const now = () => new Date(2028, 1, 28, 23, 55);
  const reply = createAgent(store, interpret, now);
  const history: ChatMessage[] = [];
  async function say(content: string) {
    history.push({ role: "user", content });
    const answer = await reply([...history]);
    history.push({ role: "assistant", content: answer });
    return answer;
  }
  return { store, file, say };
}

test("六轮验收与重载后的清单", async (t) => {
  const { say, file, store } = await setup(t);
  assert.match(await say("帮我记一下买牛奶"), /已添加/);
  assert.match(await say("再记一条取快递"), /取快递/);
  const [milk, parcel] = store.list();
  assert.equal(milk.title, "买牛奶");
  assert.equal(parcel.title, "取快递");
  assert.match(await say("我有哪些任务？"), /待办（2）[\s\S]*买牛奶[\s\S]*取快递/);
  assert.match(await say("牛奶买好了"), /已完成/);
  assert.deepEqual(store.list(), [{ ...milk, done: true }, parcel]);
  assert.match(await say("取快递这条删掉吧"), /已删除/);
  const last = await say("再给我看看清单");
  assert.match(last, /已完成（1）[\s\S]*买牛奶/);
  assert.doesNotMatch(last, /快递/);
  const reopened = createJsonTaskStore(file);
  assert.deepEqual(reopened.list(), [{ ...milk, done: true }]);
  assert.equal(await createAgent(reopened)([{ role: "user", content: "看看清单" }]), last);
});

test("完成口语保留动词，否定和疑问不修改任务", async (t) => {
  const { say, store } = await setup(t);
  const wash = store.create("洗衣服");
  const buy = store.create("买衣服");
  for (const phrase of ["衣服还没洗好", "衣服洗好了吗？", "别把买衣服删掉", "查看未完成任务"]) {
    await say(phrase);
    assert.deepEqual(store.list(), [wash, buy]);
  }
  await say("衣服洗好了");
  assert.deepEqual(store.list(), [{ ...wash, done: true }, buy]);
  assert.match(await say("衣服洗好了"), /已经完成/);
});

test("相似任务按补充标题消歧，同名任务可按序号选择或取消", async (t) => {
  const { say, store } = await setup(t);
  const office = store.create("取公司快递");
  const home = store.create("取家里快递");
  assert.match(await say("快递取了"), /你要完成哪一项/);
  assert.deepEqual(store.list(), [office, home]);
  await say("公司的");
  assert.deepEqual(store.list(), [{ ...office, done: true }, home]);
  const copy = store.create(home.title);
  assert.match(await say("删掉取家里快递"), /你要删除哪一项/);
  await say("取消");
  assert.equal(store.list().length, 3);
  await say("删掉取家里快递");
  await say("第二条");
  assert.equal(
    store.list().some((task) => task.id === copy.id),
    false,
  );
  assert.equal(
    store.list().some((task) => task.id === home.id),
    true,
  );
});

test("候选项被重命名后答序号不会误删", async (t) => {
  const { say, store } = await setup(t);
  const first = store.create("会议 A");
  store.create("会议 B");
  await say("删除会议");
  store.update(first.id, { title: "复习考试" });
  assert.match(await say("第一个"), /清单刚发生变化/);
  assert.equal(store.list().length, 2);
});

test("追问中的无效序号和过期上下文不会触发模型写入", async (t) => {
  let calls = 0;
  const interpret: Interpret = async () => {
    calls++;
    return { action: "create", title: "不应创建" };
  };
  const { say, store } = await setup(t, interpret);
  store.create("取公司快递");
  store.create("取家里快递");
  const question = await say("删除快递");
  assert.equal(await say("第三个"), question);
  const afterRestart = createAgent(store, interpret);
  assert.match(
    await afterRestart([
      { role: "assistant", content: question },
      { role: "user", content: "第二个" },
    ]),
    /重新查看清单/,
  );
  assert.equal(calls, 0);
  assert.equal(store.list().length, 2);
});

test("空清单、非法标题、无匹配和日期边界", async (t) => {
  const { say, store } = await setup(t);
  assert.match(await say("看看清单"), /空/);
  assert.match(await say("记一下"), /1 至 200/);
  await say("记一条" + "长".repeat(201));
  assert.match(await say("删除不存在的任务"), /找不到/);
  assert.match(await say("记一条 2028-02-30 交报告"), /日期不存在/);
  assert.deepEqual(store.list(), []);
  await say("记一下今天交报告");
  await say("记一条明天买菜");
  await say("提醒我后天交作业");
  store.create("旧记录");
  assert.deepEqual(
    store.list().map((task) => task.dueDate),
    ["2028-02-28", "2028-02-29", "2028-03-01", undefined],
  );
  assert.match(await say("今天有哪些任务到期？"), /今天到期（1）[\s\S]*交报告/);
  await say("交报告完成了");
  assert.match(await say("今天有哪些任务到期？"), /没有到期/);
});

test("模型可解析开放表达，歧义和越界 ID 仍由执行层处理", async (t) => {
  let proposal: unknown;
  const { say, store } = await setup(t, async () => proposal);
  proposal = { action: "create", title: "还书" };
  assert.match(await say("我怕把归还图书馆的书这件事忘在脑后"), /已添加「还书」/);
  const [book] = store.list();
  proposal = { action: "complete", ids: [book.id, "missing"] };
  assert.match(await say("书已经回到图书馆啦"), /找不到/);
  assert.deepEqual(store.list(), [book]);
  proposal = { action: "complete", ids: [book.id] };
  assert.match(await say("书已经回到图书馆啦"), /已完成/);
  store.create("还书");
  proposal = { action: "delete", ids: [book.id] };
  assert.match(await say("把归还借阅物这一项撤掉"), /你要删除哪一项/);
  assert.equal(store.list().length, 2);
});

test("模型返回无效结构或超时，清单保持可用", async (t) => {
  let fail = false;
  const { say, store } = await setup(t, async () => {
    if (fail) throw new Error("timeout");
    return { action: "create", title: "" };
  });
  for (const value of [false, true]) {
    fail = value;
    assert.match(await say("我担心会忘了那本书"), /没能解析/);
    assert.deepEqual(store.list(), []);
  }
  await say("记一下买牛奶");
  assert.equal(store.list().length, 1);
});

test("模型解析期间其他请求修改清单时放弃陈旧操作", async (t) => {
  const { say, store } = await setup(t, async (_messages, snapshot) => {
    store.update(snapshot[0].id, { title: "另一场会议" });
    return { action: "delete", ids: [snapshot[0].id] };
  });
  const task = store.create("周五开会");
  assert.match(await say("周五的碰头会取消啦"), /清单刚发生变化/);
  assert.deepEqual(store.list(), [{ ...task, title: "另一场会议" }]);
});
