export const NOTICE_SHOWN = 'notices/shown';

export function showNotice(key: string) {
  return { type: NOTICE_SHOWN, key };
}
