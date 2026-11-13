import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { mergeMap } from 'rxjs/operators';
import { ClubService } from './club.service';
import { joinClub } from './club.actions';

@Injectable()
export class ClubEffects {
  constructor(private actions$: Actions, private clubs: ClubService) {}

  joinClub$ = createEffect(() =>
    this.actions$.pipe(ofType(joinClub), mergeMap((action) => this.clubs.join(action.clubId))),
  );
}
