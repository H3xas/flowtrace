import { Component } from '@angular/core';
import { GoneService } from './gone.service';
import { CurrentWeatherService } from './current-weather.service';

@Component({
  selector: 'app-missing-page',
  templateUrl: './missing.page.html',
})
export class MissingPage {
  constructor(private gone: GoneService, private live: CurrentWeatherService) {}

  probe() {
    this.gone.loadGone('north');
  }

  ok() {
    this.live.loadWeather('north');
  }
}
