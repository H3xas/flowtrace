import { Component, Input } from '@angular/core';

@Component({
  selector: 'tp-buoy',
  template: '<span *ngIf="childFlag">lit</span><i *ngIf="spare">spare</i><b *ngIf="drift">drift</b>',
})
export class BuoyComponent {
  @Input() childFlag: boolean;
  @Input() spare: string;
  @Input() drift: boolean;
}
