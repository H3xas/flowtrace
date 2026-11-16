import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class RaceService {
  constructor(private gateway: GatewayService) {}

  today() {
    return this.gateway.get('race/v1/today');
  }

  checkIn() {
    return this.gateway.post('race/v1/checkin', {});
  }

  marks() {
    return this.gateway.get('race/v1/marks');
  }

  briefing() {
    return this.gateway.get('race/v1/briefing');
  }

  rules() {
    return this.gateway.get('race/v1/rules');
  }

  protest() {
    return this.gateway.post('race/v1/protest', {});
  }
}
