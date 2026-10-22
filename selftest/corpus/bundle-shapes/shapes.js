/**
 * Every literal below spells an import or an export that this module does not have, the way
 * a doc comment spells one as an example: export { A, B as C }, export { X as default }.
 * export default Widget;
 * import { missing } from './missing-from-a-block-comment.js';
 */
// export const fromLineComment = 1;
// import './missing-from-a-line-comment.js';

export const single = 'export { D, E as F }; import.meta.url';
export const double = "export default G; import { gone } from './missing-from-a-string.js';";
export const template = `
export function H() {}
import { gone } from './missing-from-a-template.js';
export { ${single.length > 0 ? `nested ${'export { K }'}` : ''} as L }
`;
export const pattern = /export \{ M \}|['"`]|\/\/ export const N = 1;/;
export const ratio = 12 / 3 / 2;

export function texts() {
  return [single, double, template, pattern.source, String(ratio)];
}

export default function describeShapes() {
  return 'the one real default export';
}
