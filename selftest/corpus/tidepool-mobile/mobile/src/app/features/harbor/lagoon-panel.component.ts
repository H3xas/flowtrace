import { Component } from '@angular/core';

@Component({
  selector: 'tp-lagoon-panel',
  template: '<tp-buoy [childFlag]="flags.flagB" spare="on"></tp-buoy>',
})
export class LagoonPanelComponent {
  flags = { flagB: true };
}
