import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class DecisionForms {
  private mode = OPEN ? 'wide' : 'narrow';

  constructor(private http: HttpClient) {}

  branches(entry: Entry, mode: string): string {
    if (entry.open) {
      return 'open';
    } else if (mode === 'all') {
      return 'all';
    } else {
      return 'closed';
    }
  }

  single(entry: Entry): number {
    if (entry.pinned) return 1;
    else return 2;
  }

  clauses(kind: string): number {
    switch (kind) {
      case 'a':
        return 1;
      case 'b':
      case 'c':
        return 2;
      default:
        return 3;
    }
  }

  expressions(entry: Entry, list: Entry[]): unknown {
    const label = entry.ready ? 'ready' : 'waiting';
    const owner = entry.owner ?? 'nobody';
    const visible = entry.open && entry.total > 0;
    const grouped = (entry.open && entry.pinned) || entry.ready;
    const found = list.filter((item) => item.open || item.pinned);
    const ratio = entry.total ?.5 : 1;
    const level = entry.total > 9
      ? 'high'
      : 'low';
    return { label, owner, visible, grouped, found, ratio, level };
  }

  conditions(entry: Entry, list: Entry[]): number {
    if (entry.open && list.some((item) => item.ready && item.total > 0)) {
      return 1;
    }
    for (let i = 0; i < list.length && entry.open; i += 1) {
      entry.total += 1;
    }
    while (entry.total > 3 || entry.open) {
      entry.total -= 1;
    }
    return entry.open && entry.pinned ? 2 : 3;
  }

  quiet(entry: Entry): string {
    const text = 'is it open? yes && no || maybe ?? never';
    const template = `count ${entry.total} ? && || ??`;
    // open? then && go || stop ?? later
    /* ready ? a : b */
    const pattern = /a?b&&c||d/g;
    const depth = entry.child?.depth;
    const call = entry.handler?.(1);
    entry.total &&= 1;
    entry.owner ||= 'x';
    entry.owner ??= 'y';
    type Kind<T> = T extends string ? 'text' : 'other';
    type Loose<T> = { [K in keyof T]?: T[K] };
    let shape: { name?: string; size?(): number } = {};
    const make = (first?: string, second?: number) => first;
    return text + template + pattern.source;
  }
}

export const LIMIT = OPEN ? 1 : 2;

export const helpers = {
  pick(x: number) {
    return x ? 1 : 2;
  },
};
