import { Injectable } from '@angular/core';
import { CycleBService } from './cycle-b.service';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class CycleAService {
  constructor(private b: CycleBService, private gateway: GatewayService) {}

  loadA(plotId: string) {
    return this.gateway.get(`orchard/v1/cycle/a/${plotId}`);
  }

  pingA(plotId: string) {
    this.loadA(plotId);
    return this.b.pingB(plotId);
  }
}
