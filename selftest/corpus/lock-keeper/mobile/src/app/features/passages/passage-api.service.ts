import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class PassageApiService {
  constructor(private gateway: GatewayService) {}

  save(passage: unknown) {
    return this.gateway.post('lock/v1/passages', passage);
  }

  load(passageId: string) {
    return this.gateway.get(`lock/v1/passages/${passageId}`);
  }
}
