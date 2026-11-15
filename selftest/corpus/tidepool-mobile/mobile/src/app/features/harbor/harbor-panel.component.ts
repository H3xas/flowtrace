import { Component, Input } from '@angular/core';
import { Store } from '@ngrx/store';
import { selectTide } from '../reef/tide.selectors';

@Component({
  selector: 'tp-harbor-panel',
  templateUrl: './harbor-panel.component.html',
})
export class HarborPanelComponent {
  @Input() config: any;
  @Input() open: boolean;
  showDock = false;
  ready = true;
  locked = false;
  mode = 'calm';
  items = [];
  tide$ = this.store.select(selectTide);

  constructor(private store: Store<any>) {}

  ngOnInit() {
    this.showDock = this.config?.dock.open;
  }

  get quiet() {
    return this.mode === 'calm';
  }
}
