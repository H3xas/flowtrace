import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
class MetricsService {
  constructor(private gateway: GatewayService) {}

  loadMetrics(plotId: string) {
    return this.gateway.get(`orchard/v1/metrics/${plotId}`);
  }
}

export { MetricsService as MetricsApi };
