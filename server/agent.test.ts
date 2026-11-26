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

test("删除追问按完整标题选中原候选 ID，同名候选需要再次选择", async (t) => {
  const { say, store } = await setup(t);
  const first = store.create("删除旧照片");
  const video = store.create("删除旧视频");
  const photo = store.create("旧照片");
  assert.match(await say("删除旧"), /回复序号或标题/);
  assert.match(await say("删除旧照片"), /已删除「删除旧照片」/);
  assert.deepEqual(store.list(), [video, photo]);
  const a = store.create(first.title);
  const b = store.create(first.title);
  await say("删除旧");
  assert.match(await say(first.title), /回复序号或标题/);
  assert.deepEqual(store.list(), [video, photo, a, b]);
  await say("第二个");
  assert.deepEqual(store.list(), [video, photo, a]);
});

test("过期或发生变更的删除追问收到命令式标题时保留原记录", async (t) => {
  const { say, store } = await setup(t);
  const first = store.create("删除旧照片");
  store.create("删除旧视频");
  store.create("旧照片");
  const question = await say("删除旧");
  const before = store.list();
  const restarted = createAgent(store);
  assert.match(
    await restarted([
      { role: "assistant", content: question },
      { role: "user", content: first.title },
    ]),
    /重新查看清单/,
  );
  assert.deepEqual(store.list(), before);
  store.update(first.id, { title: "保存旧照片" });
  const renamed = store.list();
  assert.match(await say(first.title), /重新查看清单/);
  assert.deepEqual(store.list(), renamed);
});

test("删除追问中输入候选以外的删除指令需要先取消", async (t) => {
  const { say, store } = await setup(t);
  store.create("旧照片 A");
  store.create("旧照片 B");
  store.create("发票");
  const before = store.list();
  const question = await say("删除旧照片");
  assert.equal(await say("删除发票"), question);
  assert.deepEqual(store.list(), before);
  await say("取消");
  assert.deepEqual(store.list(), before);
  assert.match(await say("删除发票"), /已删除「发票」/);
});

test("优先级的两种词序返回相同结果，并保留工作量和完成状态筛选", async (t) => {
  const { say, store } = await setup(t);
  const report = store.create("交报告", { priority: 1, workload: "large" });
  const archives = store.create("交材料", { priority: 1, workload: "small" });
  store.create("买菜", { priority: 3, workload: "large" });
  store.create("还书", { priority: 2 });
  store.update(archives.id, { done: true });
  const before = store.list();
  for (const [level, title] of [
    ["高", report.title],
    ["中", "还书"],
    ["低", "买菜"],
  ]) {
    const control = await say("只看" + level + "优先级任务");
    assert.ok(control.includes(title));
    assert.equal(await say("只看优先级为" + level + "的任务"), control);
  }
  const selected = await say("查看优先级是高、工作量为小的已完成任务");
  assert.match(selected, /已完成（1）[\s\S]*交材料/);
  assert.doesNotMatch(selected, /交报告|买菜|还书/);
  assert.deepEqual(store.list(), before);
});

test("已完成与未完成的自然问句只读取对应记录", async (t) => {
  const { say, store } = await setup(t);
  const wash = store.create("洗衣服");
  const buy = store.create("买菜");
  assert.match(await say("我已经完成了哪些任务？"), /还没有已完成/);
  assert.match(await say("完成了洗衣服"), /已完成「洗衣服」/);
  const before = [{ ...wash, done: true }, buy];
  for (const phrase of ["我已经完成了哪些任务？", "完成了哪些任务", "哪些任务已经完成了？"]) {
    assert.equal(await say(phrase), await say("查看已完成任务"));
    assert.deepEqual(store.list(), before);
  }
  assert.equal(await say("我还没完成哪些任务？"), await say("只看未完成任务"));
  assert.deepEqual(store.list(), before);
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

test("子任务、属性筛选、到期清单与磁盘重载使用相同记录", async (t) => {
  const { say, store, file } = await setup(t);
  await say("记一下复习机器学习，优先级高，工作量大");
  const [parent] = store.list();
  assert.equal(parent.priority, 1);
  assert.equal(parent.workload, "large");
  assert.match(await say("给复习机器学习添加子任务：今天做真题"), /已添加子任务「做真题」/);
  const [, child] = store.list();
  assert.equal(child.parentId, parent.id);
  assert.equal(child.dueDate, "2028-02-28");
  assert.match(await say("查看复习机器学习的子任务"), /0\/1 已完成[\s\S]*待办 · 做真题/);
  assert.match(await say("今天有哪些任务到期？"), /做真题[\s\S]*所属「复习机器学习」/);
  await say("把做真题的优先级设为高，工作量设为中");
  assert.match(await say("查看今天到期的高优先级任务"), /今天到期（1）[\s\S]*做真题/);
  assert.match(await say("只看高优先级任务"), /待办（2）/);
  const medium = await say("查看中工作量任务");
  assert.match(medium, /待办（1）[\s\S]*做真题/);
  assert.match(await say("完成复习机器学习"), /还有未完成的子任务/);
  assert.match(await say("完成复习机器学习的子任务做真题"), /已完成「做真题」/);
  assert.match(await say("查看复习机器学习的子任务"), /1\/1 已完成/);
  assert.equal(store.list()[0].done, false);
  await say("完成复习机器学习");
  assert.deepEqual(createJsonTaskStore(file).list(), [
    { ...parent, done: true },
    { ...child, done: true, priority: 1, workload: "medium" },
  ]);
  assert.match(await say("删除复习机器学习"), /先逐条删除子任务/);
  await say("删除复习机器学习的子任务做真题");
  assert.deepEqual(store.list(), [{ ...parent, done: true }]);
});

test("不同父任务下的同名子任务可消歧或用父任务限定", async (t) => {
  const { say, store } = await setup(t);
  await say("记一下周一复习");
  await say("记一下周二复习");
  assert.match(await say("给复习添加子任务：真题"), /哪条任务/);
  await say("第一个");
  await say("给周二复习添加子任务：真题");
  assert.equal(store.list().length, 4);
  const prompt = await say("把真题的工作量设为小");
  assert.match(prompt, /所属「周一复习」/);
  assert.match(prompt, /所属「周二复习」/);
  await say("第二个");
  assert.equal(store.list()[2].workload, undefined);
  assert.equal(store.list()[3].workload, "small");
  await say("删除周一复习的子任务真题");
  assert.equal(store.list()[2].parentId, store.list()[1].id);
  assert.equal(store.list().length, 3);
});

test("错误属性、丢失的父任务和嵌套层级不会生成顶层孤立记录", async (t) => {
  const { say, store } = await setup(t);
  await say("记一下交报告，工作量巨大");
  assert.deepEqual(store.list(), []);
  await say("给不存在的父任务添加子任务：资料");
  assert.deepEqual(store.list(), []);
  await say("记一下交报告");
  await say("给交报告添加子任务：找资料");
  const before = store.list();
  await say("给找资料添加子任务：下载文件");
  await say("把交报告的优先级设为特级");
  assert.deepEqual(store.list(), before);
});

test("模型结构化意图能维护父子关系与属性", async (t) => {
  let proposal: unknown;
  const { say, store } = await setup(t, async () => proposal);
  const parent = store.create("期末");
  proposal = { action: "addChild", ids: [parent.id], title: "刷题", priority: 2 };
  await say("给期末安排一个小步骤吧");
  const [, child] = store.list();
  assert.equal(child.parentId, parent.id);
  proposal = { action: "setDetails", ids: [child.id], workload: "large" };
  await say("估计这活够呛");
  assert.equal(store.list()[1].priority, 2);
  assert.equal(store.list()[1].workload, "large");
  proposal = { action: "setDetails", ids: [child.id], priority: 4 };
  assert.match(await say("这个比其他事还急"), /没能解析/);
  assert.equal(store.list()[1].priority, 2);
});
