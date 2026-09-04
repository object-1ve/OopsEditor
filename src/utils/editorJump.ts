/**
 * 内容搜索跳行:在命中行内定位首个匹配串(大小写不敏感)的列范围。
 * 返回 [startColumn, endColumn](1-based);无匹配或空查询返回 null(调用方落到行首)。
 */
export function findMatchColumns(
  lineText: string,
  query: string,
): [number, number] | null {
  if (!query) return null;
  const idx = lineText.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  return [idx + 1, idx + 1 + query.length];
}
