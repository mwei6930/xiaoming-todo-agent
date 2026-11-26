import { Router } from "express";
import { z } from "zod";
import type { TaskStore } from "./task-store.ts";
import { detailFields, dueDateSchema, titleSchema } from "./task-fields.ts";

const createTaskSchema = z.strictObject({
  title: titleSchema,
  dueDate: dueDateSchema.optional(),
  parentId: z.string().min(1).optional(),
  ...detailFields,
});
const updateTaskSchema = createTaskSchema
  .omit({ parentId: true })
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请检查任务标题、到期日、父任务 ID、优先级和工作量。" });
    }
    const { title, ...options } = input.data;
    res.status(201).json(tasks.create(title, options));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: "请提供有效的 title、done、dueDate、priority 或 workload 字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
