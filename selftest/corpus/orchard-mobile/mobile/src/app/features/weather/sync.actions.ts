import { createAction, props } from '@ngrx/store';

export const loadSensors = createAction('[Weather] Load sensors', props<{ plotId: string }>());
export const loadSummary = createAction('[Weather] Load summary', props<{ plotId: string }>());
