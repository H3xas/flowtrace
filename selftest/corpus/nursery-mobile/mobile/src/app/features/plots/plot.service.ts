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
    return this.gateway.put(`nursery/v1/plots/${plotId}/` + this.watchKind(), {});
  }

  markHealthy(plotId: string) {
    return this.gateway.post(`nursery/v1/plots/${plotId}/health`, {});
  }

  // Built by a call the extractor cannot read, so the request template stays unresolved
  // while its literal path prefix still names the collection.
  private watchKind() {
    return ['watchers', 'shares'].join('/');
  }
}
