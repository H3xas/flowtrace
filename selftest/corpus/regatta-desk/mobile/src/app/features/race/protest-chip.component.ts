import { Component } from '@angular/core';
import { RaceService } from './race.service';

@Component({
  selector: 'app-protest-chip',
  templateUrl: './protest-chip.component.html',
})
export class ProtestChipComponent {
  constructor(private race: RaceService) {}

  ngOnInit() {
    this.race.rules();
  }

  onProtest() {
    this.race.protest();
  }
}
