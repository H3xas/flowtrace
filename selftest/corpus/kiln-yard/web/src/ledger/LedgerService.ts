export class LedgerService {
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
