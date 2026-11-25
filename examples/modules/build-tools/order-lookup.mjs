export function lookupOrder({ id }) {
  return { id, status: id === "A-100" ? "paid" : "missing", toolVersion: "1.0.0" };
}
