import { CrateClient } from '../clients/crate-client';

export async function levelZero(crates: CrateClient, id: string) {
  await levelOne(crates, id);
}

export async function levelOne(crates: CrateClient, id: string) {
  await levelTwo(crates, id);
}

export async function levelTwo(crates: CrateClient, id: string) {
  await levelThree(crates, id);
}

export async function levelThree(crates: CrateClient, id: string) {
  await crates.delete(id);
}
