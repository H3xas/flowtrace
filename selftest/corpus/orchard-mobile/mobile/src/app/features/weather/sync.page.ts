import { Component } from '@angular/core';
import { Store } from '@ngrx/store';
import { loadSensors, loadSummary } from './sync.actions';

@Component({
  selector: 'app-sync',
  templateUrl: './sync.page.html',
})
export class SyncPage {
  plotId = 'north';

  constructor(private store: Store) {}

  onSensors() {
    this.store.dispatch(loadSensors({ plotId: this.plotId }));
  }

  onSummary() {
    this.store.dispatch(loadSummary({ plotId: this.plotId }));
  }
}
