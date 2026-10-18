import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { mergeMap } from 'rxjs/operators';
import { GatewayService } from '../../core/gateway.service';
import { syncPlot } from './plot.actions';

@Injectable()
export class PlotEffects {
  constructor(private actions$: Actions, private gateway: GatewayService) {}

  sync$ = createEffect(() =>
    this.actions$.pipe(ofType(syncPlot), mergeMap((action) => this.gateway.get(`nursery/v1/plots/${action.plotId}/sensors`))),
  );
}
