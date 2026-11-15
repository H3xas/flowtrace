import { Component } from '@angular/core';
import { Store, select } from '@ngrx/store';
import { MAX_DEPTH, selectPick } from './tide.selectors';
import { SessionService } from './session.service';

@Component({
  selector: 'tp-reef-board',
  templateUrl: './reef-board.component.html',
})
export class ReefBoardComponent {
  flags: any = {};
  key = 'flagA';
  pick$ = this.store.pipe(select(selectPick));
  depth = MAX_DEPTH;
  first = this.second;
  second = this.first;
  orphan: boolean;
  mirror: boolean;
  cells = [];
  ready = true;
  count = 0;

  constructor(private store: Store<any>, private session: SessionService) {}

  ngOnInit() {
    this.store.subscribe((snap) => {
      this.mirror = snap.on;
    });
  }

  isOpen() {
    return true;
  }
}
