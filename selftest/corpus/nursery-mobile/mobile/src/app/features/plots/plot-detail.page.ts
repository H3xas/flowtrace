import { Component, OnChanges, OnDestroy, OnInit } from '@angular/core';
import { Store } from '@ngrx/store';
import { PlotService } from './plot.service';
import { pinPlot, syncPlot } from './plot.actions';

@Component({
  selector: 'app-plot-detail',
  templateUrl: './plot-detail.page.html',
})
export class PlotDetailPage implements OnInit, OnChanges, OnDestroy {
  plotId = 'p1';
  draft = '';

  constructor(private plots: PlotService, private store: Store) {}

  ngOnInit() {
    this.plots.loadSummary(this.plotId);
  }

  ngOnChanges() {
    this.plots.loadForecast(this.plotId);
  }

  ngOnDestroy() {
    this.plots.releaseLock(this.plotId);
  }

  ionViewCanLeave() {
    return this.plots.loadHistory(this.plotId);
  }

  reloadAll() {
    this.plots.loadSeedlings(this.plotId);
  }

  onRefresh() {
    this.plots.loadSeedlings(this.plotId);
  }

  onWater() {
    this.plots.waterPlot(this.plotId);
  }

  onRelabel() {
    this.plots.relabel(this.plotId, 'north bed');
  }

  onNote() {
    this.plots.addNote(this.plotId, this.draft);
  }

  onExport() {
    this.plots.exportPlot(this.plotId);
  }

  onShareWatchers() {
    this.plots.replaceWatchers(this.plotId);
  }

  onTend() {
    this.prepareTend();
    this.plots.waterPlot(this.plotId);
  }

  prepareTend() {
    this.plots.relabel(this.plotId, 'tended');
  }

  onSync() {
    this.store.dispatch(syncPlot({ plotId: this.plotId }));
  }

  onPin() {
    this.store.dispatch(pinPlot({ plotId: this.plotId }));
  }
}
