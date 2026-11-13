import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GhostService {
  loadGhost(plotId: string) {
    return plotId;
  }
}
