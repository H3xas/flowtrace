import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class CurrentWeatherService {
  constructor(private gateway: GatewayService) {}

  loadWeather(plotId: string) {
    return this.gateway.get(`orchard/v1/weather/legacy/${plotId}`);
  }

  loadArchive(plotId: string) {
    return this.gateway.get(`orchard/v1/weather/legacy/${plotId}/archive`);
  }
}
