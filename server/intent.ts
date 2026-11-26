import { z } from "zod";
import { dueDateSchema, localDate, titleSchema } from "./task-fields.ts";
import type { Task } from "./task-store.ts";

export const intentSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    title: titleSchema,
    dueDate: dueDateSchema.optional(),
  }),
  z.strictObject({ action: z.literal("list"), scope: z.enum(["all", "open", "done", "today"]) }),
  ...(["complete", "delete"] as const).map((action) =>
    z.strictObject({ action: z.literal(action), ids: z.array(z.string().min(1)) }),
  ),
  z.strictObject({ action: z.literal("clarify"), question: z.string().trim().min(1).max(300) }),
]);

export type Intent = z.infer<typeof intentSchema>;
export type ChangeAction = "complete" | "delete";

function compact(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\s「」“”《》]/gu, "")
    .toLowerCase();
}

export function matchingTasks(reference: string, tasks: Task[]): Task[] {
  const term = compact(reference);
  if (!term) return [];
  const exact = tasks.filter((task) => compact(task.title) === term);
  if (exact.length) return exact;
  const inverted = /^(.+?)(买|洗|取|寄|交|写|读|发|拿|订|还|做|打扫|整理)$/u.exec(term);
  return tasks.filter((task) => {
    const title = compact(task.title);
    return (
      title.includes(term) ||
      (inverted && title.includes(inverted[1]) && title.includes(inverted[2]))
    );
  });
}

function change(action: ChangeAction, reference: string, tasks: Task[]): Intent {
  const target = reference
    .replace(/^(?:把|将)/u, "")
    .replace(/(?:这|那)(?:一)?(?:条|个)(?:任务|待办)?$/u, "")
    .trim();
  if (!target || /^(?:全部|所有|这些|那些|它|它们|这条|那条)(?:任务|待办)?$/u.test(target)) {
    return { action: "clarify", question: "你指的是哪一条？请告诉我任务标题。" };
  }
  return { action, ids: matchingTasks(target, tasks).map((task) => task.id) };
}

function create(text: string, now: Date): Intent {
  let title = text.trim().replace(/^[：:]\s*/u, "");
  const date = /^(今天|明天|后天|\d{4}-\d{2}-\d{2})(?:到期|截止)?[\s，,：:]*/u.exec(title);
  let dueDate: string | undefined;
  if (date) {
    const offset = ["今天", "明天", "后天"].indexOf(date[1]);
    dueDate = offset < 0 ? date[1] : localDate(now, offset);
    if (!dueDateSchema.safeParse(dueDate).success) {
      return {
        action: "clarify",
        question: "这个日期不存在。请用有效日期重新描述任务，例如“记一条 2028-02-29 交报告”。",
      };
    }
    title = title.slice(date[0].length).trim();
  }
  if (!titleSchema.safeParse(title).success) {
    return {
      action: "clarify",
      question: "想记什么事？请用 1 至 200 个字符描述，例如“帮我记一下洗衣服”。",
    };
  }
  return { action: "create", title, dueDate };
}

export function parseLocal(input: string, tasks: Task[], now: Date): Intent | undefined {
  const text = input
    .trim()
    .replace(/[。！？!?～~]+$/u, "")
    .trim()
    .replace(/^(?:小明[，,\s]*)?(?:(?:请|麻烦|帮我|给我|再)[，,\s]*)*/u, "");
  if (/(?:然后|顺便|同时)(?:再|也|帮我|把|将|记|加|删|完成)|都删|全删|全部删|都完成/u.test(text))
    return { action: "clarify", question: "一次可以处理一条任务。先处理哪一条？" };
  if (/(?:了[吗么]|过[吗么])$/u.test(text)) return { action: "list", scope: "all" };
  const add =
    /^(?:记下来|记下|记上|记录|添加|新增|新建|创建|提醒我|[记加](?=一下|一条|一项|一个|个|待办|任务|[：:\s]|$))(?:一下|一条|一项|一个|个)?(?:待办事项|待办|任务)?[：:\s]*(.*)$/su.exec(
      text,
    );
  if (add) return create(add[1], now);

  const mentionsWrite = /(?:删|移除|勾选|标记|完成了)/u.test(text);
  if (!mentionsWrite && /今天.*(?:到期|截止)|(?:到期|截止).*今天/u.test(text)) {
    return { action: "list", scope: "today" };
  }
  if (
    !mentionsWrite &&
    /(?:清单|待办|任务|事项|哪些|没做的|已完成|未完成)/u.test(text) &&
    /^(?:(?:我|今天|目前|现在|只|想|还|再|给我|一下)*(?:看|查|列|显示|有|哪些|什么)|(?:我的)?(?:任务|待办|清单)$)/u.test(
      text,
    )
  ) {
    return {
      action: "list",
      scope: /未完成|没做的|只看待办/u.test(text)
        ? "open"
        : /已完成|完成的/u.test(text)
          ? "done"
          : "all",
    };
  }
  if (
    /^(?:取消|算了|不用了|不改了)$/u.test(text) ||
    /(?:别|暂缓|不要|不用删|不想|还没|尚未|没有|没买|没洗|没取|没做|未完成$)/u.test(text)
  ) {
    return { action: "clarify", question: "好的，清单保持原样。" };
  }
  if (/^(?:如果|假如|要是)/u.test(text))
    return { action: "clarify", question: "等你确定要操作时，告诉我具体任务就好。" };
  if (/[?？]/u.test(input) || /(?:吗|么|没有)$/u.test(text)) return undefined;
  const remove =
    /^(?:删除|删掉|移除|删去|去掉|删)(.+?)(?:吧)?$/u.exec(text) ??
    /^(.+?)(?:删除|删掉|移除|去掉|删了|删除掉)(?:吧)?$/u.exec(text);
  if (remove) return change("delete", remove[1], tasks);
  const completed =
    /^(?:完成了|完成|勾选|勾掉)(.+)$/u.exec(text) ??
    /^(.+?)(?:标记|标|设)(?:为|成)?(?:已)?完成(?:吧)?$/u.exec(text) ??
    /^(.+?)(?:已经|已)?(?:搞定了|弄好了|做完了|完成了|办完了|做好了)$/u.exec(text);
  if (completed) return change("complete", completed[1], tasks);
  // “衣服洗好了”保留“洗”，让查找同时考虑任务的动作和对象。
  const result = /^(.+?)(?:回来了|到了|好了|完了|了)$/u.exec(text);
  if (result) {
    const candidate = change("complete", result[1].replace(/(?:已经|已)/gu, ""), tasks);
    if (
      candidate.action === "complete" &&
      (candidate.ids.length || /(?:好了|完了|到了|回来了)$/u.test(text))
    )
      return candidate;
  }
  return undefined;
}
