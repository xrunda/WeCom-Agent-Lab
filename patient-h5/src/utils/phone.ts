/**
 * 手机号归一（与后端 src/p1/patient-h5.ts 的 normalizePhone 同口径）。
 *
 * 通讯录里复制出来的号码常带 +86、空格或短横线；页面上先归一，
 * 避免用户明明填对了却被提示「号码格式不对」。
 */
export function normalizePhone(input: string): string | null {
  let value = input.replace(/[\s‐-―-]/g, '');
  if (value.startsWith('+86')) value = value.slice(3);
  else if (value.startsWith('0086')) value = value.slice(4);
  else if (/^861[3-9]\d{9}$/.test(value)) value = value.slice(2);
  return /^1[3-9]\d{9}$/.test(value) ? value : null;
}
