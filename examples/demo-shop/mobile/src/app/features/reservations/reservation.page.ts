import { Component } from '@angular/core';
import { ReservationService } from './reservation.service';

@Component({
  selector: 'app-reservation-page',
  templateUrl: './reservation.page.html',
})
export class ReservationPage {
  constructor(private reservations: ReservationService) {}

  reserve() {
    this.reservations.reserve('p1');
  }
}
