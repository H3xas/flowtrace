import { Component } from '@angular/core';
import { Store } from '@ngrx/store';
import { RaceService } from './race.service';
import { loadBriefing } from './race.actions';

@Component({
  selector: 'app-race-day',
  templateUrl: './race-day.page.html',
})
export class RaceDayPage {
  constructor(private race: RaceService, private store: Store) {}

  ngOnInit() {
    this.race.today();
  }

  ionViewWillEnter() {
    this.store.dispatch(loadBriefing());
  }

  ionViewDidEnter() {
    this.race.marks();
  }

  onCheckIn() {
    this.race.checkIn();
  }
}
