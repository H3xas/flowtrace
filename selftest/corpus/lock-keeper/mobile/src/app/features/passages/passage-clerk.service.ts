import { Injectable } from '@angular/core';
import { PassageLedger } from './passage-ledger';

@Injectable({ providedIn: 'root' })
export class PassageClerkService {
  file(ready: boolean, x: Passage) {
    if (ready) {
      PassageLedger.record(x);
    }
  }
}
