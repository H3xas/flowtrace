import { Injectable } from '@angular/core';
import { of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { GatewayService } from '../../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class PlotService {
  constructor(private gateway: GatewayService) {}

  loadSeedlings(plotId: string) {
    return of(plotId).pipe(mergeMap((id) => this.gateway.get(`nursery/v1/plots/${id}/seedlings`)));
  }

  waterPlot(plotId: string) {
    return this.gateway.post(`nursery/v1/plots/${plotId}/water`, {});
  }

  relabel(plotId: string, label: string) {
    return this.gateway.put(`nursery/v1/plots/${plotId}/label`, { label });
  }

  loadSummary(plotId: string) {
    return this.gateway.get(`nursery/v1/plots/${plotId}/summary`);
  }

  loadForecast(plotId: string) {
    return this.gateway.get(`nursery/v1/plots/${plotId}/forecast`);
  }

  releaseLock(plotId: string) {
    return this.gateway.delete(`nursery/v1/plots/${plotId}/lock`);
  }

  loadHistory(plotId: string) {
    return this.gateway.get(`nursery/v1/plots/${plotId}/history`);
  }

  addNote(plotId: string, note: string) {
    return this.gateway
      .post(`nursery/v1/plots/${plotId}/notes`, { note });
  }

  exportPlot(plotId: string) {
    return this.gateway.get(`nursery/v1/plots/${plotId}/export`);
  }

  replaceWatchers(plotId: string) {
    return this.gateway.put(this.watchUrl(plotId), {});
  }

  markHealthy(plotId: string) {
    return this.gateway.post(`nursery/v1/plots/${plotId}/health`, {});
  }

  private watchUrl(plotId: string) {
    return ['nursery/v1/plots', plotId, 'watchers'].join('/');
  }
}
