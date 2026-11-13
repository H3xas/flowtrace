import { createAction, props } from '@ngrx/store';

export const joinClub = createAction('[Club] Join', props<{ clubId: string }>());
