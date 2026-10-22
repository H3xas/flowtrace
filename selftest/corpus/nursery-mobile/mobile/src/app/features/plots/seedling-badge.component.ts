import { Component } from '@angular/core';
import { PlotService } from './plot.service';

@Component({
  selector: 'app-seedling-badge',
  templateUrl: './seedling-badge.component.html',
})
export class SeedlingBadgeComponent {
  constructor(private plots: PlotService) {}

  onMark() {
    this.plots.markHealthy('p1');
  }
}
