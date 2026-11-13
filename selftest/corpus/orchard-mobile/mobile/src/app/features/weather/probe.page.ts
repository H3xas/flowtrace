import { Component } from '@angular/core';
import type { GhostService } from './ghost.service';
import { CurrentWeatherService } from './current-weather.service';

@Component({
  selector: 'app-probe-page',
  templateUrl: './probe.page.html',
})
export class ProbePage {
  constructor(private ghost: GhostService, private live: CurrentWeatherService) {}

  probe() {
    this.ghost.loadGhost('north');
  }

  ok() {
    this.live.loadWeather('north');
  }
}
