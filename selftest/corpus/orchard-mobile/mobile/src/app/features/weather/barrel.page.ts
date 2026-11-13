import { Component } from '@angular/core';
import { CurrentWeatherService } from './forwarded';
import { MetricsApi } from './metrics.service';

@Component({
  selector: 'app-barrel-page',
  templateUrl: './barrel.page.html',
})
export class BarrelPage {
  constructor(private weather: CurrentWeatherService, private metrics: MetricsApi) {}

  probe() {
    this.weather.loadWeather('north');
  }

  measure() {
    this.metrics.loadMetrics('north');
  }
}
