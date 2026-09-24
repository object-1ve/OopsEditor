/**
 * 会话面板的时间格式化
 * 规则与聊天软件一致：今天显示时刻，昨天/星期几用相对说法，更早显示日期。
 */

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

// 「今天/昨天」按自然日比较，而不是按 24 小时差，跨零点时才会正确翻页。
// 两端都取当天零点再相减，避开夏令时导致的非整数天。
function calendarDayDiff(date: Date, now: Date): number {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((to - from) / 86_400_000);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** 解析后端返回的 RFC3339 时间；无法解析时返回 null */
export function parseChatTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 完整时间：2026-09-24 11:14 */
export function formatChatDateTime(value: string | null | undefined): string {
  const date = parseChatTime(value);
  if (!date) return "未知时间";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

/** 会话列表里的时间列：今天 → 11:14，昨天 → 昨天，一周内 → 星期X，更早 → 月日 */
export function formatConversationTime(
  value: string | null | undefined,
  now: Date = new Date(),
): string {
  const date = parseChatTime(value);
  if (!date) return "";

  const diff = calendarDayDiff(date, now);
  if (diff <= 0) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (diff === 1) return "昨天";
  if (diff < 7) return WEEKDAYS[date.getDay()];
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 消息流里的日期分隔标题：今天 / 昨天 / 9月24日 星期四 */
export function formatDayDivider(
  value: string | null | undefined,
  now: Date = new Date(),
): string {
  const date = parseChatTime(value);
  if (!date) return "";
  const diff = calendarDayDiff(date, now);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  const weekday = WEEKDAYS[date.getDay()];
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
}

/** 相邻两条消息是否需要在中间插入时间分隔（跨天或间隔超过 5 分钟） */
export function needsTimeDivider(
  previous: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const currentDate = parseChatTime(current);
  if (!currentDate) return false;

  const previousDate = parseChatTime(previous);
  if (!previousDate) return true;
  if (calendarDayDiff(previousDate, currentDate) !== 0) return true;

  return currentDate.getTime() - previousDate.getTime() >= 5 * 60 * 1000;
}
