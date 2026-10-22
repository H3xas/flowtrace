export function pingA(count: number): number {
  return count > 0 ? pingB(count - 1) : 0;
}

export function pingB(count: number): number {
  return count > 0 ? pingA(count - 1) : 0;
}
