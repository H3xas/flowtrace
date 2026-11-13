import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class ClubService {
  constructor(private gateway: GatewayService) {}

  join(clubId: string) {
    return this.gateway.post(`clubs/v1/join/${clubId}`, {});
  }
}
