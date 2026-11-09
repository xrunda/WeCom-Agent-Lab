/** 草稿与实发正文的字符级 diff，用于服务流详情里的差异高亮。 */

export interface DiffSegment {
  type: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * 字符级 LCS diff。草稿正文一般不超过几百字，O(n*m) 足够；
 * 超过 2000 字时退化为整体对比，避免页面卡顿。
 */
export function diffSegments(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ type: 'same', text: before }] : [];
  if (before.length * after.length > 4_000_000) {
    return [
      { type: 'removed', text: before },
      { type: 'added', text: after },
    ];
  }

  const a = Array.from(before);
  const b = Array.from(after);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] =
        a[i - 1] === b[j - 1]
          ? table[(i - 1) * cols + (j - 1)] + 1
          : Math.max(table[(i - 1) * cols + j], table[i * cols + (j - 1)]);
    }
  }

  const reversed: DiffSegment[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      reversed.push({ type: 'same', text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j] > table[i * cols + (j - 1)]) {
      reversed.push({ type: 'removed', text: a[i - 1] });
      i -= 1;
    } else {
      reversed.push({ type: 'added', text: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    reversed.push({ type: 'removed', text: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    reversed.push({ type: 'added', text: b[j - 1] });
    j -= 1;
  }

  reversed.reverse();
  const merged: DiffSegment[] = [];
  for (const segment of reversed) {
    const last = merged[merged.length - 1];
    if (last && last.type === segment.type) last.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}
