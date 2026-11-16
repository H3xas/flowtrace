import { Injectable } from '@angular/core';
import { GatewayService } from '../../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class ConsoleSettingsService {
  constructor(private gateway: GatewayService) {}

  load() {
    return this.gateway.get('lanterns/v1/settings');
  }
}
