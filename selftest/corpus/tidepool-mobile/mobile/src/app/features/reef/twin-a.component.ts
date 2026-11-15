import { Component, Input } from '@angular/core';

@Component({
  selector: 'tp-twin',
  template: '<p *ngIf="shown">a</p>',
})
export class TwinAComponent {
  @Input() shown: boolean;
}
