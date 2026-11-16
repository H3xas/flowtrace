// Returns the title with the case reference added, the way a reporter wrapper does.
export const caseRef = Object.assign(
  (ids: number | string | Array<number | string>, title: string): string => `${title} (Case ${ids})`,
  { id: (ids: number | string | Array<number | string>, _note?: string): void => undefined },
);
