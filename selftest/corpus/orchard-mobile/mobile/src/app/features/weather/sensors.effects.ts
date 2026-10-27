import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { mergeMap } from 'rxjs/operators';
import { GatewayService } from '../core/gateway.service';
import { loadSensors } from './sync.actions';

@Injectable()
export class SyncEffects {
  constructor(private actions$: Actions, private gateway: GatewayService) {}

  sync$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadSensors),
      mergeMap((action) => this.gateway.get(`orchard/v1/weather/current/${action.plotId}`)),
    ),
  );
}
