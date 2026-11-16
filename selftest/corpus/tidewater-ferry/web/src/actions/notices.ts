export const NOTICE_SHOWN = 'notices/shown';

export function noticeShown(text: string) {
  return { type: NOTICE_SHOWN, text };
}
