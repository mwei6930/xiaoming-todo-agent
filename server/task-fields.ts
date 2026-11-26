import { z } from "zod";

export const titleSchema = z.string().trim().min(1).max(200);
export const dueDateSchema = z.iso.date();
export const prioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const workloadSchema = z.enum(["small", "medium", "large"]);
export const detailFields = {
  priority: prioritySchema.optional(),
  workload: workloadSchema.optional(),
};
export type Details = {
  priority?: z.infer<typeof prioritySchema>;
  workload?: z.infer<typeof workloadSchema>;
};
export const priorityLabels = { 1: "高", 2: "中", 3: "低" } as const;
export const workloadLabels = { small: "小", medium: "中", large: "大" } as const;

export function describeDetails({ priority, workload }: Details) {
  const parts: string[] = [];
  if (priority !== undefined) parts.push(`优先级${priorityLabels[priority]}`);
  if (workload !== undefined) parts.push(`工作量${workloadLabels[workload]}`);
  return parts.join("，");
}

// 日历日期跟随运行服务的用户时区；跨午夜或夏令时也按本地日期计算。
export function localDate(now: Date, offset = 0): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
