import { Component, Input } from '@angular/core';

@Component({
  selector: 'tp-twin',
  template: '<p *ngIf="shown">b</p>',
})
export class TwinBComponent {
  @Input() shown: boolean;
}
