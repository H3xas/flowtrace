import { Injectable } from '@angular/core';
import { GatewayService } from '../../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class LedgerService {
  constructor(private gateway: GatewayService) {}

  loadLedger(plotId: string) {
    return this.gateway.get(`orchard/v1/ledger/${plotId}`);
  }
}
