export function filterObject(opts: { in: any[]; [key: string]: any }) {
  const { in: arr, ...criteria } = opts;
  return arr.filter((obj) => {
    for (const [key, value] of Object.entries(criteria)) {
      if (obj[key] !== value) {
        return false;
      }
    }
    return true;
  });
}
