import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
class HiddenProbeService {
  loadHidden(plotId: string) {
    return plotId;
  }
}
