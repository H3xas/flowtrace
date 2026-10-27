import { Component } from '@angular/core';
import { Store } from '@ngrx/store';
import { joinClub } from './club.actions';

@Component({
  selector: 'app-club-about',
  templateUrl: './club-about.page.html',
})
export class ClubAboutPage {
  clubId = 'c1';

  constructor(private store: Store) {}

  onJoin() {
    this.store.dispatch(joinClub({ clubId: this.clubId }));
  }
}
