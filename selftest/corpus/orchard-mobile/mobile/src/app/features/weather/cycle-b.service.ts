import { Injectable } from '@angular/core';
import { CycleAService } from './cycle-a.service';

@Injectable({ providedIn: 'root' })
export class CycleBService {
  constructor(private a: CycleAService) {}

  pingB(plotId: string) {
    return this.a.pingA(plotId);
  }
}
