import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { mergeMap } from 'rxjs/operators';
import { RaceService } from './race.service';
import { loadBriefing } from './race.actions';

@Injectable()
export class RaceEffects {
  constructor(private actions$: Actions, private race: RaceService) {}

  loadBriefing$ = createEffect(() =>
    this.actions$.pipe(ofType(loadBriefing), mergeMap(() => this.race.briefing())),
  );
}
