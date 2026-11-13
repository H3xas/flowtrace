import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class GatewayService {
  constructor(private http: HttpClient) {}

  post(path: string, body: unknown) {
    return this.http.post(path, body);
  }
}
