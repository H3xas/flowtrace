import { Component } from '@angular/core';
import { CurrentWeatherService } from '../weather/current-weather.service';

@Component({
  selector: 'app-forecast-live',
  templateUrl: './live-forecast.page.html',
})
export class ForecastPage {
  constructor(private weather: CurrentWeatherService) {}

  onLive() {
    this.weather.loadForecast('north');
  }

  onSummary() {
    this.weather.loadSummary('north');
  }
}
