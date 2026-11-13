import { Component } from '@angular/core';
import { ClubService } from './club.service';

@Component({
  selector: 'app-club-invite',
  template: '<ion-content>Invited</ion-content>',
})
export class ClubInvitePage {
  clubId = 'c1';

  constructor(private clubs: ClubService) {}

  ionViewDidEnter() {
    this.clubs.join(this.clubId);
  }
}
