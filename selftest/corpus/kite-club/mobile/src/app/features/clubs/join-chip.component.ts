import { Component } from '@angular/core';
import { ClubService } from './club.service';

@Component({
  selector: 'app-join-chip',
  templateUrl: './join-chip.component.html',
})
export class JoinChipComponent {
  clubId = 'c1';

  constructor(private clubs: ClubService) {}

  onJoin() {
    this.clubs.join(this.clubId);
  }
}
