import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { detailFields, dueDateSchema } from "./task-fields.ts";

const originalTask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  dueDate: dueDateSchema.optional(),
});
const taskList = z.array(originalTask);
type DiskTask = z.infer<typeof originalTask>;
// 旧版本允许自由扩展字段。读取时只解释支持的值，局部更新时保留原始数据。
const taskView = originalTask.extend({
  parentId: z.string().min(1).optional().catch(undefined),
  priority: detailFields.priority.catch(undefined),
  workload: detailFields.workload.catch(undefined),
});
export type Task = z.infer<typeof taskView>;
type TaskChanges = Partial<Pick<Task, "title" | "done" | "dueDate" | "priority" | "workload">>;
type TaskOptions = Pick<Task, "dueDate" | "priority" | "workload" | "parentId">;

export class TaskRelationError extends Error {
  status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.status = status;
  }
}

export interface TaskStore {
  list(): Task[];
  create(title: string, options?: TaskOptions | string): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function read(): DiskTask[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: DiskTask[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list: () => read().map((item) => taskView.parse(item)),

    create(title, options = {}) {
      const fields = typeof options === "string" ? { dueDate: options } : options;
      const tasks = read();
      if (fields.parentId !== undefined) {
        const parent = tasks.find((item) => item.id === fields.parentId);
        if (!parent) throw new TaskRelationError("找不到这条父任务。", 404);
        if (parent.parentId) throw new TaskRelationError("目前支持一层子任务。请选一条顶层任务。");
        if (parent.done) throw new TaskRelationError("父任务已经完成，无法继续添加子任务。");
      }
      const task = { ...fields, id: randomUUID(), title, done: false };
      save([...tasks, task]);
      return task;
    },

    update(id, changes) {
      const tasks = read();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;
      if (changes.done === true && tasks.some((item) => item.parentId === id && !item.done)) {
        throw new TaskRelationError("还有未完成的子任务，请先完成或删除它们。");
      }
      if (changes.done === false && tasks.some((item) => item.id === task.parentId && item.done)) {
        throw new TaskRelationError("请先重新打开父任务，再重新打开子任务。");
      }

      Object.assign(task, changes);
      save(tasks);
      return taskView.parse(task);
    },

    remove(id) {
      const tasks = read();
      if (tasks.some((item) => item.parentId === id))
        throw new TaskRelationError("这条任务还有子任务，请先逐条删除子任务。");
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}
