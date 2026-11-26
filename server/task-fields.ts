import { z } from "zod";

export const titleSchema = z.string().trim().min(1).max(200);
export const dueDateSchema = z.iso.date();

// 日历日期跟随运行服务的用户时区；跨午夜或夏令时也按本地日期计算。
export function localDate(now: Date, offset = 0): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
