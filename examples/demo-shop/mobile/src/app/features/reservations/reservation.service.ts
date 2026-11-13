import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class ReservationService {
  constructor(private gateway: GatewayService) {}

  reserve(productId: string) {
    return this.gateway.post('stock/v1/reservations', { productId });
  }
}
