export interface DispatchItem {
  serial: string;
  origin: string;
}

export interface DispatchState {
  plans: { items: DispatchItem[] };
}
