import { Component, inject } from '@angular/core';
import { CurrentWeatherService as Current } from './current-weather.service';
import { CurrentWeatherService as Archive } from './legacy-weather.service';
import { MetricsApi } from './metrics.service';
import { LedgerService } from './ledger/index.ts';

@Component({
  selector: 'app-weather-page',
  templateUrl: './weather.page.html',
})
export class WeatherPage {
  private live = inject(Current);

  constructor(private archive: Archive, private metrics: MetricsApi, private ledger: LedgerService) {}

  refresh() {
    this.live.loadWeather('north');
    this.archive.loadWeather('north');
  }

  summary() {
    this.live.loadSummary('north');
  }

  measure() {
    this.metrics.loadMetrics('north');
  }

  ledger() {
    this.ledger.loadLedger('north');
  }
}
