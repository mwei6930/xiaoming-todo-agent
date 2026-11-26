import type { ChatMessage } from "../shared/chat.ts";
import {
  intentSchema,
  matchingTasks,
  parseLocal,
  type TargetIntent,
  type Intent,
} from "./intent.ts";
import type { Interpret } from "./model.ts";
import { describeDetails, localDate, type Details } from "./task-fields.ts";
import { TaskRelationError, type Task, type TaskStore } from "./task-store.ts";

const help = "可以说“帮我记一下洗衣服”“看看清单”“衣服洗好了”或“把洗衣服这条删掉”。";
const changed = "清单刚发生变化。请重新查看清单，告诉我要操作哪一项。";
const missing = "清单里找不到对应的任务。可以先说“看看清单”。";
const label = (task: Task) => task.title.replace(/\s+/gu, " ");

function describeTask(task: Task, all: Task[]) {
  const parent = task.parentId ? all.find((item) => item.id === task.parentId) : undefined;
  const children = all.filter((item) => item.parentId === task.id);
  const parts = [label(task)];
  if (parent) parts.push(`所属「${label(parent)}」`);
  if (children.length)
    parts.push(`子任务 ${children.filter((item) => item.done).length}/${children.length}`);
  if (task.dueDate) parts.push(`${task.dueDate} 到期`);
  if (task.priority || task.workload) parts.push(describeDetails(task));
  return parts.join("  ·  ");
}

function showList(
  all: Task[],
  scope: "all" | "open" | "done" | "today",
  today: string,
  filter: Details = {},
) {
  const tasks = all.filter(
    (item) =>
      (!filter.priority || item.priority === filter.priority) &&
      (!filter.workload || item.workload === filter.workload),
  );
  const open = tasks.filter((task) => !task.done && (scope !== "today" || task.dueDate === today));
  const done = tasks.filter((task) => task.done);
  function group(name: string, items: Task[]) {
    const lines = items.map((task) => "• " + describeTask(task, all));
    return [`${name}（${items.length}）`, ...lines].join("\n");
  }
  if (scope === "today")
    return open.length ? group("今天到期", open) : "今天没有到期且未完成的任务。";
  if (scope === "open") return open.length ? group("待办", open) : "没有待办任务。";
  if (scope === "done") return done.length ? group("已完成", done) : "还没有已完成的任务。";
  const groups = [];
  if (open.length) groups.push(group("待办", open));
  if (done.length) groups.push(group("已完成", done));
  return (
    groups.join("\n\n") ||
    (describeDetails(filter) ? "没有符合条件的任务。" : "清单是空的。想记什么事？")
  );
}

interface PendingChoice {
  intent: TargetIntent;
  tasks: Task[];
}

function selectOption(text: string, options: Task[]): Task[] {
  const answer = text.trim().replace(/[。！!]+$/u, "");
  const id = /^#([a-f\d-]{8,})$/iu.exec(answer);
  if (id) return options.filter((task) => task.id.startsWith(id[1].toLowerCase()));
  const number = /^(?:选|选择)?第?(\d+|[一二三四五六七八九十])(?:个|条|项)?$/u.exec(answer);
  if (number) {
    const index = Number(number[1]) || "一二三四五六七八九十".indexOf(number[1]) + 1;
    return options[index - 1] ? [options[index - 1]] : [];
  }
  return matchingTasks(answer.replace(/(?:的)?(?:那个|那条|那项|的)$/u, ""), options);
}

export function createAgent(store: TaskStore, interpret?: Interpret, now = () => new Date()) {
  // 问题中包含稳定的任务编号。同一服务的不同页面可各自回答最近的追问。
  const questions = new Map<string, PendingChoice>();

  function ask(intent: TargetIntent, options: Task[]) {
    const all = store.list();
    const lines = options.map((task, i) => {
      const prefix = task.id.slice(0, 8);
      const unique = options.filter((item) => item.id.startsWith(prefix)).length === 1;
      const state = task.done ? "已完成" : "待办";
      return `${i + 1}. ${describeTask(task, all)}（${state}，#${unique ? prefix : task.id}）`;
    });
    const verbs = {
      complete: "完成",
      delete: "删除",
      children: "查看哪条任务的子任务",
      addChild: "给哪条任务添加子任务",
      setDetails: "修改",
    };
    const detail =
      intent.action === "addChild"
        ? [`添加子任务「${intent.title}」`, intent.dueDate, describeDetails(intent)]
            .filter(Boolean)
            .join("，")
        : intent.action === "setDetails"
          ? describeDetails(intent)
          : "";
    const question =
      intent.action === "children" || intent.action === "addChild"
        ? verbs[intent.action]
        : verbs[intent.action] + "哪一项";
    const prompt = `你要${question}？${detail ? detail + "。" : ""}回复序号或标题，也可以说“取消”。\n${lines.join("\n")}`;
    questions.set(prompt, { intent, tasks: options });
    if (questions.size > 100) questions.delete(questions.keys().next().value!);
    return prompt;
  }

  function applyTarget(intent: TargetIntent, snapshot: Task) {
    const all = store.list();
    const task = all.find((item) => item.id === snapshot.id);
    if (!task || JSON.stringify(task) !== JSON.stringify(snapshot)) return changed;
    try {
      switch (intent.action) {
        case "delete":
          return store.remove(task.id) ? `已删除「${label(task)}」。` : changed;
        case "complete":
          if (task.done) return `「${label(task)}」之前已经完成了。`;
          return store.update(task.id, { done: true }) ? `已完成「${label(task)}」。` : changed;
        case "addChild": {
          const { title, dueDate, priority, workload } = intent;
          const child = store.create(title, { parentId: task.id, dueDate, priority, workload });
          return `已添加子任务「${label(child)}」，所属「${label(task)}」。`;
        }
        case "children": {
          const children = all.filter((item) => item.parentId === task.id);
          if (!children.length) return `「${label(task)}」还没有子任务。`;
          const rows = children.map(
            (child) => `${child.done ? "已完成" : "待办"} · ${describeTask(child, all)}`,
          );
          return [
            `「${label(task)}」的子任务（${children.filter((child) => child.done).length}/${children.length} 已完成）`,
            ...rows,
          ].join("\n");
        }
        case "setDetails": {
          const changes: Details = {};
          if (intent.priority !== undefined) changes.priority = intent.priority;
          if (intent.workload !== undefined) changes.workload = intent.workload;
          const updated = store.update(task.id, changes);
          return updated ? `已更新「${label(task)}」：${describeDetails(updated)}。` : changed;
        }
      }
    } catch (error) {
      if (error instanceof TaskRelationError) return error.message;
      throw error;
    }
  }

  return async function reply(messages: ChatMessage[]): Promise<string> {
    const input = messages.at(-1)?.content.trim();
    if (!input) return help;
    const snapshot = store.list();
    const date = now();
    const today = localDate(date);
    let intent: Intent | undefined = parseLocal(input, snapshot, date);
    const previous = messages.at(-2);
    const pending = previous?.role === "assistant" ? questions.get(previous.content) : undefined;
    if (
      !intent &&
      !pending &&
      previous?.role === "assistant" &&
      /^你要[^\n]+？[^\n]*回复序号或标题/u.test(previous.content)
    )
      return changed;
    if (!intent && pending) {
      const options = selectOption(input, pending.tasks);
      if (options.length === 1) return applyTarget(pending.intent, options[0]);
      return ask(pending.intent, options.length ? options : pending.tasks);
    }

    const noLocalMatch = intent && "ids" in intent && !intent.ids.length;
    const useModel = interpret && (!intent || noLocalMatch);
    if (useModel) {
      const requestedAction = intent?.action;
      try {
        intent = intentSchema.parse(await interpret(messages, snapshot, today));
      } catch {
        return "这次没能解析你的意思，清单尚未修改。请稍后再试，或换一种说法。" + help;
      }
      if (requestedAction && intent.action !== requestedAction && intent.action !== "clarify")
        return missing;
      if (
        intent.action !== "list" &&
        intent.action !== "clarify" &&
        JSON.stringify(store.list()) !== JSON.stringify(snapshot)
      )
        return changed;
    }

    if (!intent) return help;
    switch (intent.action) {
      case "clarify":
        return intent.question;
      case "list":
        return showList(store.list(), intent.scope, today, intent);
      case "create": {
        const { title, dueDate, priority, workload } = intent;
        const task = store.create(title, { dueDate, priority, workload });
        const due = task.dueDate ? `，${task.dueDate} 到期` : "";
        const details = describeDetails(task);
        return `已添加「${label(task)}」${due}${details ? "，" + details : ""}。`;
      }
      case "complete":
      case "children":
      case "setDetails":
      case "addChild":
      case "delete": {
        const ids = new Set(intent.ids);
        const matches = snapshot.filter((task) => ids.has(task.id));
        if (!matches.length || matches.length !== ids.size) return missing;
        // 即使模型只选中了一个 ID，完全同名的记录仍需要用户区分。
        const candidates = snapshot.filter((task) =>
          matches.some(
            (item) => (useModel || item.parentId === task.parentId) && label(item) === label(task),
          ),
        );
        return candidates.length > 1 ? ask(intent, candidates) : applyTarget(intent, candidates[0]);
      }
    }
  };
}
