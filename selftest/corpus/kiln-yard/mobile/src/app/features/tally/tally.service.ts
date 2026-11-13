import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class TallyService {
  constructor(private http: HttpClient) {}

  load(id: string) {
    return this.http.get(`/kiln/v1/kilns/${id}/firings`);
  }

  pick(entry: Entry): string {
    if (entry.open) {
      return 'open';
    }
    return 'closed';
  }
}
