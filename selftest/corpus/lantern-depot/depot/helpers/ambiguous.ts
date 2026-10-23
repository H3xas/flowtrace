export async function closeAny(holder, id: string) {
  await holder.close(id);
}

export async function dropAny(holder, id: string) {
  await holder.delete(id);
}
