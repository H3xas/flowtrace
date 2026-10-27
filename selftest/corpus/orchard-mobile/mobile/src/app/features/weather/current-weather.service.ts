import { Injectable } from '@angular/core';
import { GatewayService } from '../core/gateway.service';

@Injectable({ providedIn: 'root' })
export class CurrentWeatherService {
  constructor(private gateway: GatewayService) {}

  loadWeather(plotId: string) {
    return this.gateway.get(`orchard/v1/weather/current/${plotId}`);
  }

  loadSummary(plotId: string) {
    return this.gateway.get(`orchard/v1/weather/current/${plotId}/summary`);
  }

  loadForecast(plotId: string) {
    return this.gateway.get(`orchard/v1/weather/current/${plotId}/forecast`);
  }
}
