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

  genericInterface() {
    interface Sized<T> { size?(): T }
    return 0;
  }

  genericClass() {
    class Sized<T> { size?(): T; }
    return Sized;
  }

  constrainedGeneric() {
    interface Sized<T extends {}> { size?(): T }
    class Kept<T = { a: number }> { size?(): T; }
    interface Called<T extends (a: { b: number }) => void> { size?(): number }
    return Kept;
  }

  mixinHeritage() {
    class Mixed extends mix(Base) { size?(): number; }
    return Mixed;
  }

  genericHeritage() {
    interface Sized extends Array<number> { size?(): number }
    class Kept extends Map<string, number> { size?(): number; }
    return Kept;
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

  asType(y: unknown) {
    const a = y as { size?(): number };
    const b = y as { size? (): number };
    return [a, b];
  }

  satisfiesType(y: object) {
    const a = y satisfies { size?(): number };
    const b = y satisfies { size? (): number };
    return [a, b];
  }

  keyofType() {
    let a: keyof { size?(): number };
    let b: keyof { size? (): number };
    return [a, b];
  }

  readonlyType() {
    let a: readonly { size?(): number }[] = [];
    let b: readonly { size? (): number }[] = [];
    return [a, b];
  }

  predicateType() {
    function sized(v: unknown): v is { size?(): number } {
      return true;
    }
    function spaced(v: unknown): v is { size? (): number } {
      return true;
    }
    return [sized, spaced];
  }

  arrowReturnType() {
    let f: () => { size?(): number };
    return f;
  }

  tupleType() {
    const t: [{ size?(): number }] = [];
    return t;
  }

  angleAssertion(y: unknown) {
    const s = <{ size?(): number }>y;
    return s;
  }

  angleSpaced(y: unknown) {
    const s = <{ size? (): number }>y;
    return s;
  }

  typeParamDefault() {
    type L<T = { a?(): void }> = T;
    return 0;
  }

  plainGroup(a: boolean, b: number, c: number, x: number) {
    a?(x):b;
    f(c, a?(x):b);
    a?(x+1):b;
  }

  hiddenElse(a: boolean) {
    if (a) run(); // else stop();
  }

  nameBeforeBlock(x: boolean) {
    const is = 1
    is
    { x ? a() : b(); }
    let as = 1
    as
    { x ? c() : d(); }
  }

  callGroups(a: boolean, b: number, fs: Array<() => number>) {
    a?(fs[0]()):b;
    a?(new Date()):b;
  }
}
