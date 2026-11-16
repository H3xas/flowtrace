import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class ZoneWatcherFeed {
  constructor(private gateway: GatewayService) {}

  listWatchers(zoneId: string) {
    return this.gateway.get(`greenhouse/v1/zones/${zoneId}/watchers`);
  }
}
