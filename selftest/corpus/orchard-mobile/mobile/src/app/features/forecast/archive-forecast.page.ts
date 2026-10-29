import { Component } from '@angular/core';
import { CurrentWeatherService } from '../weather/legacy-weather.service';

@Component({
  selector: 'app-forecast-archive',
  templateUrl: './archive-forecast.page.html',
})
export class ForecastPage {
  constructor(private archive: CurrentWeatherService) {}

  onArchive() {
    this.archive.loadArchive('north');
  }
}
