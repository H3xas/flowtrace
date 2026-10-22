export interface ZoneReading {
  sensor: string;
  value: number;
}

export interface Grower {
  id: string;
  name: string;
}

export interface GreenhouseState {
  zoneReadings: { items: ZoneReading[] };
  watchers: { growers: Grower[] };
}
