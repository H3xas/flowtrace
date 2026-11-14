import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ScannerForms {
  regexIf(ok: boolean, s: string) {
    if (ok) /a?b/.test(s);
    if (ok) /a?b:c/.test(s);
  }

  regexWhile(s: string) {
    while (s) /c||d/.exec(s);
  }

  regexFor(s: string) {
    for (const x of [s]) /e??f/.test(x);
  }

  regexWith(o: object, s: string) {
    with (o) /g?h:i/.test(s);
  }

  division(a: number, b: number, d: number, e: number) {
    return (a) / b ? d : d / e;
  }

  annotated() {
    const t: { size? () : number } = {};
    return t;
  }

  typeLiteral() {
    type Sized = { size?(): number };
    type Spaced = { size ? () : number };
    return 0;
  }

  localInterface() {
    interface Sized { size?(): number }
    return 0;
  }

  localClass() {
    class Sized { size?(): number; }
    return Sized;
  }

  typeArgument() {
    const sized = new Map<string, { size?(): number }>();
    return sized;
  }

  tightTernary(a: boolean) {
    a?(run()):stop();
  }

  spacedTernary(a: boolean) {
    a ? (run()) : stop();
  }

  halfTernary(a: boolean) {
    a?(run()) : stop();
  }

  nestedElse(a: boolean, b: boolean) {
    if (a)
      if (b) run();
      else stop();
  }

  elseChain(a: boolean, b: boolean, c: boolean) {
    if (a) if (b) x(); else if (c) y(); else z();
  }
}
