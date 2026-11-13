import { Component } from '@angular/core';
import { HiddenProbeService } from './private-probe.service';
import { MetricsApi } from './metrics.service';

@Component({
  selector: 'app-private-page',
  templateUrl: './private.page.html',
})
export class PrivatePage {
  constructor(private hidden: HiddenProbeService, private metrics: MetricsApi) {}

  probe() {
    this.hidden.loadHidden('north');
  }

  measure() {
    this.metrics.loadMetrics('north');
  }
}
