export async function closeAny(holder, id: string) {
  await holder.close(id);
}
