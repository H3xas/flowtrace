import { Component } from '@angular/core';
import { OutsideService } from '../../../../../outside.service';
import { CurrentWeatherService } from './current-weather.service';

@Component({
  selector: 'app-escape-page',
  templateUrl: './escape.page.html',
})
export class EscapePage {
  constructor(private outside: OutsideService, private live: CurrentWeatherService) {}

  probe() {
    this.outside.loadOutside('north');
  }

  ok() {
    this.live.loadWeather('north');
  }
}
