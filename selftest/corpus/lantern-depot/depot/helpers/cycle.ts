import { BinClient } from '../clients/bin-client';

export async function pingNorth(bins: BinClient, id: string, again: boolean) {
  if (again) await pingSouth(bins, id, false);
  await bins.open(id);
}

export async function pingSouth(bins: BinClient, id: string, again: boolean) {
  if (again) await pingNorth(bins, id, false);
}

export async function spinEast(id: string) {
  await spinWest(id);
}

export async function spinWest(id: string) {
  await spinEast(id);
}
