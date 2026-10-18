import { createAction, props } from '@ngrx/store';

export const syncPlot = createAction('[Plot] Sync', props<{ plotId: string }>());
export const pinPlot = createAction('[Plot] Pin', props<{ plotId: string }>());
