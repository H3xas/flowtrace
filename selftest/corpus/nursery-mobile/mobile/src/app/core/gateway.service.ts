import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class GatewayService {
  constructor(private http: HttpClient) {}

  get(path: string) {
    return this.http.get(path);
  }

  post(path: string, body: unknown) {
    return this.http.post(path, body);
  }

  put(path: string, body: unknown) {
    return this.http.put(path, body);
  }

  delete(path: string) {
    return this.http.delete(path);
  }
}
